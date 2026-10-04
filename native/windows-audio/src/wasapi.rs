//! WASAPI shared-mode capture thread (Windows only).
//!
//! Adapted from Project Raven (MIT, Copyright (c) 2026 Laxcorp Software Design -
//! FZCO), commit 692cd17606e9f2d0063e2c32c9e250eaa5f60ddc,
//! src/native/windows/src/wasapi.rs: per-stream thread with CoInitializeEx(MTA),
//! 20 ms polling loop over GetNextPacketSize / GetBuffer / ReleaseBuffer, and
//! resampling to 16 kHz mono i16.
//!
//! Differences from Raven (see AUDIO_DEVICE_REQUIREMENT.md):
//! - The endpoint is opened only by explicit ID (IMMDeviceEnumerator::GetDevice).
//!   GetDefaultAudioEndpoint is never used for capture and there is no fallback.
//! - The endpoint must be ACTIVE and have the right data flow for the stream.
//! - AUDCLNT_SHAREMODE_SHARED only. The stream is tagged AudioCategory_Other via
//!   IAudioClient2::SetClientProperties so it is not a communications stream.
//!   AUDCLNT_STREAMFLAGS_NOPERSIST keeps Windows from persisting any session
//!   volume/mute state for it. Nothing writes Windows audio configuration.
//! - Correct float / int format handling, QPC timestamps, discontinuity flags,
//!   synthetic silence for idle loopback, structured error events.

use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use windows::core::{ComInterface, Interface, Result as WinResult};
use windows::Win32::Media::Audio::{
    eCapture, eRender, AudioCategory_Other, AudioClientProperties, IAudioCaptureClient,
    IAudioClient, IAudioClient2, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_NOPERSIST, AUDCLNT_STREAMOPTIONS_NONE, AUDCLNT_S_BUFFER_EMPTY,
};
use windows::Win32::System::Com::CLSCTX_ALL;

use crate::clock;
use crate::codes::*;
use crate::com::*;
use crate::dsp::{decode_to_mono, Pipeline, SampleFormat, WaveFormatInfo};
use crate::{CaptureEvent, MixFormat, StartupReport, StreamKind};

const POLL_INTERVAL_MS: u64 = 20;
/// 1 s shared-mode buffer (as in Raven): plenty of slack for a 20 ms poll.
const BUFFER_DURATION_HNS: i64 = 10_000_000;

/// A failure with its contract error code.
#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub hresult: Option<String>,
}

impl Failure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Failure { code: code.into(), message: message.into(), hresult: None }
    }

    fn hr(ctx: &str, e: &windows::core::Error, fallback: &'static str) -> Self {
        let hr = e.code().0 as u32;
        Failure {
            code: hresult_to_code(hr, fallback).into(),
            message: format!("{ctx} failed: {}", e.message()),
            hresult: Some(hresult_hex(hr)),
        }
    }
}

enum RunEnd {
    /// stopCapture() was called.
    Requested,
    /// startCapture() had already given up waiting (timeout); exit quietly.
    Abandoned,
}

/// Calls IAudioClient::Stop() when dropped, so every exit path after Start()
/// (normal stop, loop error, panic unwind) stops the stream.
struct StopOnDrop<'a>(&'a IAudioClient);

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        if let Err(e) = unsafe { self.0.Stop() } {
            eprintln!("[sales-copilot-audio] IAudioClient::Stop failed: {}", hresult_hex(e.code().0 as u32));
        }
    }
}

/// Thread entry point. Reports the startup outcome on `startup`, then streams
/// events through `emit` until `stop` is set or an error occurs.
pub fn capture_thread(
    kind: StreamKind,
    endpoint_id: String,
    stop: Arc<AtomicBool>,
    startup: Sender<StartupReport>,
    emit: &dyn Fn(CaptureEvent),
) {
    let mut startup = Some(startup);
    let result = panic::catch_unwind(AssertUnwindSafe(|| run(kind, &endpoint_id, &stop, &mut startup, emit)));
    let failure = match result {
        Ok(Ok(RunEnd::Requested)) => {
            emit(CaptureEvent::Stopped { reason: "requested" });
            return;
        }
        Ok(Ok(RunEnd::Abandoned)) => return,
        Ok(Err(f)) => f,
        Err(p) => {
            let msg = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".into());
            Failure::new("internal", format!("capture thread panicked: {msg}"))
        }
    };
    eprintln!(
        "[sales-copilot-audio] {} capture failed: {} {} {:?}",
        kind.as_str(),
        failure.code,
        failure.message,
        failure.hresult
    );
    if let Some(tx) = startup.take() {
        // Failed before streaming: the result goes back through startCapture().
        let _ = tx.send(StartupReport::Failed { code: failure.code, error: failure.message });
    } else {
        emit(CaptureEvent::Error { code: failure.code, message: failure.message, hresult: failure.hresult });
        emit(CaptureEvent::Stopped { reason: "error" });
    }
}

fn run(
    kind: StreamKind,
    endpoint_id: &str,
    stop: &AtomicBool,
    startup: &mut Option<Sender<StartupReport>>,
    emit: &dyn Fn(CaptureEvent),
) -> Result<RunEnd, Failure> {
    unsafe {
        // Declared first so it is dropped last, after every COM object below.
        let _com = ComInit::mta().map_err(|e| Failure::hr("CoInitializeEx", &e, "internal"))?;

        let en = enumerator().map_err(|e| Failure::hr("CoCreateInstance(MMDeviceEnumerator)", &e, "internal"))?;

        // Explicit endpoint ID only. Never GetDefaultAudioEndpoint, never a fallback.
        let device = match device_by_id(&en, endpoint_id) {
            Ok(d) => d,
            Err(e) if is_not_found(e.code().0 as u32) => {
                return Err(Failure {
                    code: "device_not_found".into(),
                    message: format!("endpoint not found: {endpoint_id}"),
                    hresult: Some(hresult_hex(e.code().0 as u32)),
                })
            }
            Err(e) => return Err(Failure::hr("IMMDeviceEnumerator::GetDevice", &e, "open_failed")),
        };

        let state = device.GetState().map_err(|e| Failure::hr("IMMDevice::GetState", &e, "open_failed"))?;
        if state != DEVICE_STATE_ACTIVE {
            return Err(Failure::new(
                "device_not_active",
                format!("endpoint is {} (not active): {endpoint_id}", state_to_str(state)),
            ));
        }

        let flow = device_flow(&device).map_err(|e| Failure::hr("IMMEndpoint::GetDataFlow", &e, "open_failed"))?;
        let (want_flow, stream_flags) = match kind {
            StreamKind::SystemRemote => (eRender, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_NOPERSIST),
            StreamKind::LocalMic => (eCapture, AUDCLNT_STREAMFLAGS_NOPERSIST),
        };
        if flow != want_flow {
            return Err(Failure::new(
                "wrong_flow",
                format!(
                    "{} needs a {} endpoint but {endpoint_id} is a {} endpoint",
                    kind.as_str(),
                    flow_to_str(want_flow),
                    flow_to_str(flow)
                ),
            ));
        }

        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| Failure::hr("IMMDevice::Activate(IAudioClient)", &e, "open_failed"))?;

        set_non_communications_category(&client);

        let mix = CoMixFormat::get(&client).map_err(|e| Failure::hr("IAudioClient::GetMixFormat", &e, "open_failed"))?;
        let info: WaveFormatInfo = mix.info().map_err(|m| Failure::new("unsupported_format", m))?;
        let sample_format: SampleFormat = info.sample_format().map_err(|m| Failure::new("unsupported_format", m))?;
        let mut pipeline = Pipeline::new(info.sample_rate).map_err(|m| Failure::new("unsupported_format", m))?;

        // Shared mode only. Exclusive mode would take the headset away from Zoom.
        client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, stream_flags, BUFFER_DURATION_HNS, 0, mix.as_ptr(), None)
            .map_err(|e| Failure::hr("IAudioClient::Initialize", &e, "open_failed"))?;
        drop(mix); // CoTaskMemFree; the client keeps its own copy.

        let capture: IAudioCaptureClient = client
            .GetService()
            .map_err(|e| Failure::hr("IAudioClient::GetService(IAudioCaptureClient)", &e, "open_failed"))?;

        client.Start().map_err(|e| Failure::hr("IAudioClient::Start", &e, "open_failed"))?;
        let _stop_guard = StopOnDrop(&client);

        eprintln!(
            "[sales-copilot-audio] {} started on {endpoint_id}: {} Hz, {} ch, {} bit, {:?}",
            kind.as_str(),
            info.sample_rate,
            info.channels,
            info.bits_per_sample,
            sample_format
        );

        let mix_format = MixFormat {
            sample_rate: info.sample_rate,
            channels: info.channels as u32,
            bits_per_sample: info.bits_per_sample as u32,
            is_float: info.is_float(),
        };
        if let Some(tx) = startup.take() {
            if tx.send(StartupReport::Started(mix_format)).is_err() {
                // startCapture() timed out and already returned a failure.
                return Ok(RunEnd::Abandoned);
            }
        }

        pipeline.set_origin(clock::now_ms());
        let channels = info.channels as usize;
        let block_align = info.block_align as usize;

        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            let mut got_packet = false;

            loop {
                let next = capture
                    .GetNextPacketSize()
                    .map_err(|e| Failure::hr("IAudioCaptureClient::GetNextPacketSize", &e, "internal"))?;
                if next == 0 {
                    break;
                }

                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                let mut qpc_hns = 0u64;
                // Raw vtable call so AUDCLNT_S_BUFFER_EMPTY (a success code after which
                // ReleaseBuffer must NOT be called) can be told apart from S_OK.
                let hr = (Interface::vtable(&capture).GetBuffer)(
                    Interface::as_raw(&capture),
                    &mut data,
                    &mut frames,
                    &mut flags,
                    std::ptr::null_mut(),
                    &mut qpc_hns,
                );
                if hr == AUDCLNT_S_BUFFER_EMPTY {
                    break;
                }
                hr.ok()
                    .map_err(|e| Failure::hr("IAudioCaptureClient::GetBuffer", &e, "internal"))?;

                // Copy out (cannot fail) so ReleaseBuffer always follows GetBuffer.
                let silent = flags & BUFFERFLAGS_SILENT != 0 || data.is_null();
                let bytes: Option<Vec<u8>> = if frames > 0 && !silent {
                    Some(std::slice::from_raw_parts(data, frames as usize * block_align).to_vec())
                } else {
                    None
                };
                capture
                    .ReleaseBuffer(frames)
                    .map_err(|e| Failure::hr("IAudioCaptureClient::ReleaseBuffer", &e, "internal"))?;

                let discontinuity = flags & BUFFERFLAGS_DATA_DISCONTINUITY != 0;
                if frames == 0 && !discontinuity {
                    continue;
                }
                got_packet |= frames > 0;

                let mono = match bytes {
                    Some(b) => decode_to_mono(&b, sample_format, channels, block_align),
                    None => vec![0.0f32; frames as usize],
                };
                let qpc_ms = if flags & BUFFERFLAGS_TIMESTAMP_ERROR != 0 || qpc_hns == 0 {
                    None
                } else {
                    Some(clock::hns_to_ms(qpc_hns))
                };
                let chunks = pipeline
                    .push(&mono, qpc_ms, discontinuity)
                    .map_err(|m| Failure::new("internal", m))?;
                for c in chunks {
                    emit_chunk(emit, c);
                }
            }

            // WASAPI loopback delivers no packets while nothing is rendering;
            // keep the timeline continuous with marked synthetic silence.
            if kind == StreamKind::SystemRemote && !got_packet {
                for c in pipeline.idle_tick(clock::now_ms()) {
                    emit_chunk(emit, c);
                }
            }
        }

        // Explicit Stop on the requested path (the guard also covers error/panic paths;
        // a second Stop() on a stopped stream is a harmless S_FALSE).
        if let Err(e) = client.Stop() {
            eprintln!("[sales-copilot-audio] IAudioClient::Stop failed: {}", hresult_hex(e.code().0 as u32));
        }
        eprintln!("[sales-copilot-audio] {} stopped (requested)", kind.as_str());
        Ok(RunEnd::Requested)
    }
}

fn emit_chunk(emit: &dyn Fn(CaptureEvent), c: crate::dsp::OutChunk) {
    emit(CaptureEvent::Audio {
        data: c.to_i16_le(),
        samples: c.samples.len() as u32,
        monotonic_ms: c.monotonic_ms,
        discontinuity: c.discontinuity,
        synthetic_silence: c.synthetic_silence,
    });
}

/// Tag the stream AudioCategory_Other (not Communications) before Initialize,
/// so Windows does not treat our capture as a communications stream. Best
/// effort: failure is logged and ignored. Affects only our own stream.
unsafe fn set_non_communications_category(client: &IAudioClient) {
    let res: WinResult<()> = client.cast::<IAudioClient2>().and_then(|c2| {
        let props = AudioClientProperties {
            cbSize: std::mem::size_of::<AudioClientProperties>() as u32,
            bIsOffload: false.into(),
            eCategory: AudioCategory_Other,
            Options: AUDCLNT_STREAMOPTIONS_NONE,
        };
        c2.SetClientProperties(&props)
    });
    if let Err(e) = res {
        eprintln!(
            "[sales-copilot-audio] SetClientProperties(AudioCategory_Other) failed (ignored): {}",
            hresult_hex(e.code().0 as u32)
        );
    }
}
