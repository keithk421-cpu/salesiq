//! sales-copilot-audio: Windows WASAPI capture for the Electron main process.
//!
//! Implements `NativeAudioModule` from src/shared/nativeApi.ts.
//!
//! The napi-rs ThreadsafeFunction event pattern and per-stream capture threads
//! are adapted from Project Raven (MIT, Copyright (c) 2026 Laxcorp Software
//! Design - FZCO), commit 692cd17606e9f2d0063e2c32c9e250eaa5f60ddc,
//! src/native/windows/src/lib.rs.
//!
//! Locked rules (AUDIO_DEVICE_REQUIREMENT.md): read-only towards Windows audio
//! configuration, endpoints opened by explicit ID only, WASAPI shared mode only.
//!
//! On non-Windows platforms every export exists but enumeration returns
//! nothing and startCapture returns `{ ok: false, code: 'unsupported_platform' }`.

#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

use napi::JsFunction;

mod clock;
mod codes;
mod devices;
pub mod dsp;

#[cfg(windows)]
mod com;
#[cfg(windows)]
mod wasapi;

// ---------------------------------------------------------------------------
// Contract types (camelCase on the JS side via napi-derive)
// ---------------------------------------------------------------------------

#[napi(object)]
#[derive(Debug, Clone, PartialEq)]
pub struct MixFormat {
    pub sample_rate: u32,
    pub channels: u32,
    pub bits_per_sample: u32,
    pub is_float: bool,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct EndpointInfo {
    pub id: String,
    /// 'render' | 'capture'
    pub flow: String,
    pub friendly_name: String,
    pub device_description: String,
    pub interface_name: String,
    pub form_factor: String,
    /// 'active' | 'disabled' | 'notpresent' | 'unplugged' | 'missing'
    pub state: String,
    pub is_default_console: bool,
    pub is_default_communications: bool,
    pub mix_format: Option<MixFormat>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct StartCaptureResult {
    pub ok: bool,
    pub error: Option<String>,
    pub code: Option<String>,
    pub mix_format: Option<MixFormat>,
}

impl StartCaptureResult {
    fn fail(code: &str, error: impl Into<String>) -> Self {
        StartCaptureResult { ok: false, error: Some(error.into()), code: Some(code.into()), mix_format: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    LocalMic,
    SystemRemote,
}

impl StreamKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "local_mic" => Some(StreamKind::LocalMic),
            "system_remote" => Some(StreamKind::SystemRemote),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            StreamKind::LocalMic => "local_mic",
            StreamKind::SystemRemote => "system_remote",
        }
    }

    fn index(self) -> usize {
        match self {
            StreamKind::LocalMic => 0,
            StreamKind::SystemRemote => 1,
        }
    }
}

/// Events sent from a capture thread to JS (`NativeCaptureEvent`).
#[derive(Debug)]
pub enum CaptureEvent {
    Audio {
        data: Vec<u8>,
        monotonic_ms: f64,
        samples: u32,
        discontinuity: bool,
        synthetic_silence: bool,
    },
    Error {
        code: String,
        message: String,
        hresult: Option<String>,
    },
    Stopped {
        reason: &'static str,
    },
}

/// What a capture thread tells startCapture() once it has opened (or failed to open) the stream.
#[derive(Debug)]
pub enum StartupReport {
    Started(MixFormat),
    Failed { code: String, error: String },
}

// ---------------------------------------------------------------------------
// Capture slots
// ---------------------------------------------------------------------------

struct CaptureSlot {
    stop: Arc<AtomicBool>,
    join: JoinHandle<()>,
}

impl CaptureSlot {
    fn running(&self) -> bool {
        !self.join.is_finished() && !self.stop.load(Ordering::SeqCst)
    }
}

static SLOTS: [Mutex<Option<CaptureSlot>>; 2] = [Mutex::new(None), Mutex::new(None)];

fn slot(kind: StreamKind) -> MutexGuard<'static, Option<CaptureSlot>> {
    SLOTS[kind.index()].lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg_attr(not(windows), allow(dead_code))]
const START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// Enumerate render + capture endpoints in all states. Never modifies anything.
#[napi]
pub fn list_endpoints() -> napi::Result<Vec<EndpointInfo>> {
    devices::list_endpoints().map_err(napi::Error::from_reason)
}

/// State of one endpoint by ID; 'missing' if Windows does not know the ID.
#[napi]
pub fn get_endpoint_state(endpoint_id: String) -> napi::Result<String> {
    devices::endpoint_state(&endpoint_id)
        .map(str::to_string)
        .map_err(napi::Error::from_reason)
}

/// Open `endpointId` in WASAPI shared mode for `stream` and deliver events to
/// `onEvent`. Fails (never falls back) if the endpoint is missing, inactive or
/// has the wrong data flow.
#[napi]
pub fn start_capture(stream: String, endpoint_id: String, on_event: JsFunction) -> napi::Result<StartCaptureResult> {
    let Some(kind) = StreamKind::parse(&stream) else {
        return Ok(StartCaptureResult::fail(
            "invalid_stream",
            format!("unknown stream '{stream}' (expected 'local_mic' or 'system_remote')"),
        ));
    };
    if endpoint_id.is_empty() {
        return Ok(StartCaptureResult::fail("device_not_found", "empty endpoint ID"));
    }

    let mut guard = slot(kind);
    if let Some(existing) = guard.as_ref() {
        if !existing.join.is_finished() {
            let msg = if existing.stop.load(Ordering::SeqCst) {
                "previous capture for this stream is still shutting down"
            } else {
                "already capturing this stream"
            };
            return Ok(StartCaptureResult::fail("already_capturing", msg));
        }
    }
    // Reap a capture thread that already ended on its own (e.g. after an error).
    if let Some(old) = guard.take() {
        let _ = old.join.join();
    }

    #[cfg(not(windows))]
    {
        let _ = on_event;
        Ok(StartCaptureResult::fail(
            "unsupported_platform",
            "WASAPI capture is only available on Windows",
        ))
    }

    #[cfg(windows)]
    {
        use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
        use std::sync::mpsc::{self, RecvTimeoutError};

        // Unbounded queue (0) as in Raven: audio is never dropped by the queue.
        let tsfn: ThreadsafeFunction<CaptureEvent, ErrorStrategy::Fatal> =
            on_event.create_threadsafe_function(0, |ctx| Ok(vec![event_to_js(&ctx.env, ctx.value)?]))?;

        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<StartupReport>();
        let thread_stop = stop.clone();
        let join = std::thread::Builder::new()
            .name(format!("sales-copilot-audio-{}", kind.as_str()))
            .spawn(move || {
                let emit = move |ev: CaptureEvent| {
                    tsfn.call(ev, ThreadsafeFunctionCallMode::NonBlocking);
                };
                wasapi::capture_thread(kind, endpoint_id, thread_stop, tx, &emit);
            })
            .map_err(|e| napi::Error::from_reason(format!("failed to spawn capture thread: {e}")))?;

        let result = match rx.recv_timeout(START_TIMEOUT) {
            Ok(StartupReport::Started(mix_format)) => {
                *guard = Some(CaptureSlot { stop, join });
                StartCaptureResult { ok: true, error: None, code: None, mix_format: Some(mix_format) }
            }
            Ok(StartupReport::Failed { code, error }) => {
                let _ = join.join(); // the thread exits right after reporting
                StartCaptureResult::fail(&code, error)
            }
            Err(RecvTimeoutError::Timeout) => {
                // Do not block the JS thread on a hung driver: flag the thread to stop and
                // keep its handle so stopCapture()/stopAll() can join it later.
                stop.store(true, Ordering::SeqCst);
                *guard = Some(CaptureSlot { stop, join });
                StartCaptureResult::fail("open_failed", "timed out opening the endpoint (3 s)")
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = join.join();
                StartCaptureResult::fail("internal", "capture thread exited without reporting")
            }
        };
        Ok(result)
    }
}

/// Stop that stream and join its thread. Returns whether a capture was running.
#[napi]
pub fn stop_capture(stream: String) -> bool {
    match StreamKind::parse(&stream) {
        Some(kind) => stop_kind(kind),
        None => false,
    }
}

fn stop_kind(kind: StreamKind) -> bool {
    let taken = slot(kind).take();
    match taken {
        None => false,
        Some(s) => {
            let was_running = s.running();
            s.stop.store(true, Ordering::SeqCst);
            // The loop polls the flag every 20 ms and calls IAudioClient::Stop() before exiting.
            let _ = s.join.join();
            was_running
        }
    }
}

/// Stop everything (app exit).
#[napi]
pub fn stop_all() {
    let slots: Vec<CaptureSlot> = [StreamKind::LocalMic, StreamKind::SystemRemote]
        .into_iter()
        .filter_map(|k| slot(k).take())
        .collect();
    for s in &slots {
        s.stop.store(true, Ordering::SeqCst);
    }
    for s in slots {
        let _ = s.join.join();
    }
}

#[napi]
pub fn is_capturing(stream: String) -> bool {
    match StreamKind::parse(&stream) {
        Some(kind) => slot(kind).as_ref().map(CaptureSlot::running).unwrap_or(false),
        None => false,
    }
}

/// Same monotonic clock (QPC, ms) as NativeAudioChunk.monotonicMs.
#[napi]
pub fn monotonic_now_ms() -> f64 {
    clock::now_ms()
}

#[cfg(windows)]
fn event_to_js(env: &napi::Env, ev: CaptureEvent) -> napi::Result<napi::JsObject> {
    let mut obj = env.create_object()?;
    match ev {
        CaptureEvent::Audio { data, monotonic_ms, samples, discontinuity, synthetic_silence } => {
            obj.set("kind", "audio")?;
            obj.set("data", env.create_buffer_with_data(data)?.into_raw())?;
            obj.set("monotonicMs", monotonic_ms)?;
            obj.set("samples", samples)?;
            obj.set("discontinuity", discontinuity)?;
            obj.set("syntheticSilence", synthetic_silence)?;
        }
        CaptureEvent::Error { code, message, hresult } => {
            obj.set("kind", "error")?;
            obj.set("code", code)?;
            obj.set("message", message)?;
            if let Some(hr) = hresult {
                obj.set("hresult", hr)?;
            }
        }
        CaptureEvent::Stopped { reason } => {
            obj.set("kind", "stopped")?;
            obj.set("reason", reason)?;
        }
    }
    Ok(obj)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_parse() {
        assert_eq!(StreamKind::parse("local_mic"), Some(StreamKind::LocalMic));
        assert_eq!(StreamKind::parse("system_remote"), Some(StreamKind::SystemRemote));
        assert_eq!(StreamKind::parse("mic"), None);
        assert_eq!(StreamKind::SystemRemote.as_str(), "system_remote");
    }

    #[test]
    fn idle_slots() {
        assert!(!stop_capture("local_mic".into()));
        assert!(!is_capturing("system_remote".into()));
        assert!(!is_capturing("bogus".into()));
        stop_all();
        assert!(monotonic_now_ms() >= 0.0);
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_stubs() {
        assert!(list_endpoints().unwrap().is_empty());
        assert_eq!(get_endpoint_state("x".into()).unwrap(), "missing");
    }
}
