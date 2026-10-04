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
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
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
    /// Stream names: 'local_mic', 'system_remote', and device-finder probes
    /// 'probe_render:<key>' (loopback) / 'probe_capture:<key>' (mic). Probes let the
    /// setup screen listen to several endpoints at once so Keith can see which one
    /// carries Zoom; they are the same read-only shared-mode capture.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "local_mic" => Some(StreamKind::LocalMic),
            "system_remote" => Some(StreamKind::SystemRemote),
            _ if s.len() > 13 && s.starts_with("probe_render:") => Some(StreamKind::SystemRemote),
            _ if s.len() > 14 && s.starts_with("probe_capture:") => Some(StreamKind::LocalMic),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            StreamKind::LocalMic => "local_mic",
            StreamKind::SystemRemote => "system_remote",
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

/// One capture slot per stream name (see StreamKind::parse).
static SLOTS: LazyLock<Mutex<HashMap<String, CaptureSlot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn slots() -> MutexGuard<'static, HashMap<String, CaptureSlot>> {
    SLOTS.lock().unwrap_or_else(|p| p.into_inner())
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
            format!("unknown stream '{stream}' (expected 'local_mic', 'system_remote' or a probe)"),
        ));
    };
    if endpoint_id.is_empty() {
        return Ok(StartCaptureResult::fail("device_not_found", "empty endpoint ID"));
    }

    let mut map = slots();
    if let Some(existing) = map.get(&stream) {
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
    if let Some(old) = map.remove(&stream) {
        let _ = old.join.join();
    }

    #[cfg(not(windows))]
    {
        let _ = (on_event, kind);
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
            .name(format!("sales-copilot-audio-{stream}"))
            .spawn(move || {
                let emit = move |ev: CaptureEvent| {
                    tsfn.call(ev, ThreadsafeFunctionCallMode::NonBlocking);
                };
                wasapi::capture_thread(kind, endpoint_id, thread_stop, tx, &emit);
            })
            .map_err(|e| napi::Error::from_reason(format!("failed to spawn capture thread: {e}")))?;

        let result = match rx.recv_timeout(START_TIMEOUT) {
            Ok(StartupReport::Started(mix_format)) => {
                map.insert(stream.clone(), CaptureSlot { stop, join });
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
                map.insert(stream.clone(), CaptureSlot { stop, join });
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
    let taken = slots().remove(&stream);
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
    let taken: Vec<CaptureSlot> = slots().drain().map(|(_, v)| v).collect();
    for s in &taken {
        s.stop.store(true, Ordering::SeqCst);
    }
    for s in taken {
        let _ = s.join.join();
    }
}

#[napi]
pub fn is_capturing(stream: String) -> bool {
    slots().get(&stream).map(CaptureSlot::running).unwrap_or(false)
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
        assert_eq!(StreamKind::parse("probe_render:3"), Some(StreamKind::SystemRemote));
        assert_eq!(StreamKind::parse("probe_capture:a"), Some(StreamKind::LocalMic));
        assert_eq!(StreamKind::parse("probe_render:"), None);
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
