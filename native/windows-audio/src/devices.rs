//! Endpoint enumeration and state queries. Strictly read-only.
//!
//! These are called from the Electron main (JS) thread, which may already be
//! STA-initialised. Each query therefore runs on a short-lived thread that
//! does its own CoInitializeEx(MTA)/CoUninitialize; the JS thread never calls
//! CoInitializeEx.

use crate::{EndpointInfo, MixFormat};

#[cfg(windows)]
pub use imp::{endpoint_state, list_endpoints};

#[cfg(not(windows))]
pub fn list_endpoints() -> Result<Vec<EndpointInfo>, String> {
    Ok(Vec::new())
}

#[cfg(not(windows))]
pub fn endpoint_state(_id: &str) -> Result<&'static str, String> {
    Ok("missing")
}

/// Run `f` on a fresh thread and wait for it.
#[cfg_attr(not(windows), allow(dead_code))]
fn on_fresh_thread<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    std::thread::Builder::new()
        .name("sales-copilot-audio-query".into())
        .spawn(f)
        .map_err(|e| format!("failed to spawn query thread: {e}"))?
        .join()
        .unwrap_or_else(|_| Err("query thread panicked".into()))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn mix_format_from(info: &crate::dsp::WaveFormatInfo) -> MixFormat {
    MixFormat {
        sample_rate: info.sample_rate,
        channels: info.channels as u32,
        bits_per_sample: info.bits_per_sample as u32,
        is_float: info.is_float(),
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::codes::{form_factor_to_str, hresult_hex, is_not_found, state_to_str, DEVICE_STATE_ACTIVE};
    use crate::com::*;

    use windows::core::Result as WinResult;
    use windows::Win32::Devices::FunctionDiscovery::{
        PKEY_DeviceInterface_FriendlyName, PKEY_Device_DeviceDesc, PKEY_Device_FriendlyName,
    };
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eRender, EDataFlow, ERole, IAudioClient, IMMDevice,
        IMMDeviceEnumerator, PKEY_AudioEndpoint_FormFactor, DEVICE_STATEMASK_ALL,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc, PropVariantToUInt32,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, STGM_READ};
    use windows::Win32::System::Variant::VT_EMPTY;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};

    fn err(ctx: &str, e: windows::core::Error) -> String {
        format!("{ctx} failed: {} ({})", e.message(), hresult_hex(e.code().0 as u32))
    }

    pub fn list_endpoints() -> Result<Vec<EndpointInfo>, String> {
        on_fresh_thread(|| unsafe {
            let _com = ComInit::mta().map_err(|e| err("CoInitializeEx", e))?;
            let en = enumerator().map_err(|e| err("CoCreateInstance(MMDeviceEnumerator)", e))?;
            let mut out = Vec::new();
            for flow in [eRender, eCapture] {
                list_flow(&en, flow, &mut out)?;
            }
            Ok(out)
        })
    }

    unsafe fn default_id(en: &IMMDeviceEnumerator, flow: EDataFlow, role: ERole) -> Option<String> {
        // Informational only (Windows returns ERROR_NOT_FOUND when there is no default).
        en.GetDefaultAudioEndpoint(flow, role)
            .ok()
            .and_then(|d| device_id(&d).ok())
    }

    unsafe fn list_flow(en: &IMMDeviceEnumerator, flow: EDataFlow, out: &mut Vec<EndpointInfo>) -> Result<(), String> {
        let def_console = default_id(en, flow, eConsole);
        let def_comms = default_id(en, flow, eCommunications);
        let coll = en
            .EnumAudioEndpoints(flow, DEVICE_STATEMASK_ALL)
            .map_err(|e| err("EnumAudioEndpoints", e))?;
        let count = coll.GetCount().map_err(|e| err("IMMDeviceCollection::GetCount", e))?;
        for i in 0..count {
            let dev = match coll.Item(i) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[sales-copilot-audio] {}", err("IMMDeviceCollection::Item", e));
                    continue;
                }
            };
            match describe(&dev, flow, def_console.as_deref(), def_comms.as_deref()) {
                Ok(info) => out.push(info),
                Err(e) => eprintln!("[sales-copilot-audio] skipping endpoint: {}", err("GetId", e)),
            }
        }
        Ok(())
    }

    unsafe fn describe(dev: &IMMDevice, flow: EDataFlow, def_console: Option<&str>, def_comms: Option<&str>) -> WinResult<EndpointInfo> {
        // The ID is the key; without it the endpoint is useless, so that error propagates.
        let id = device_id(dev)?;
        let state = dev.GetState().unwrap_or(0);
        let (friendly_name, device_description, interface_name, form_factor) = match dev.OpenPropertyStore(STGM_READ) {
            Ok(store) => (
                prop_string(&store, &PKEY_Device_FriendlyName),
                prop_string(&store, &PKEY_Device_DeviceDesc),
                prop_string(&store, &PKEY_DeviceInterface_FriendlyName),
                prop_u32(&store, &PKEY_AudioEndpoint_FormFactor)
                    .map(|v| form_factor_to_str(v).to_string())
                    .unwrap_or_default(),
            ),
            Err(_) => Default::default(),
        };
        let mix_format = if state == DEVICE_STATE_ACTIVE { mix_format_of(dev) } else { None };
        Ok(EndpointInfo {
            is_default_console: def_console == Some(id.as_str()),
            is_default_communications: def_comms == Some(id.as_str()),
            id,
            flow: flow_to_str(flow).to_string(),
            friendly_name,
            device_description,
            interface_name,
            form_factor,
            state: if state == 0 { "missing".into() } else { state_to_str(state).to_string() },
            mix_format,
        })
    }

    /// Activate an IAudioClient only to read its mix format. Never Initialize()d.
    unsafe fn mix_format_of(dev: &IMMDevice) -> Option<MixFormat> {
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).ok()?;
        let fmt = CoMixFormat::get(&client).ok()?;
        let info = fmt.info().ok()?;
        Some(mix_format_from(&info))
    }

    unsafe fn prop_string(store: &IPropertyStore, key: &PROPERTYKEY) -> String {
        let Ok(mut pv) = store.GetValue(key) else {
            return String::new();
        };
        let s = if pv.Anonymous.Anonymous.vt == VT_EMPTY {
            String::new()
        } else {
            PropVariantToStringAlloc(&pv).map(|p| take_co_wstr(p)).unwrap_or_default()
        };
        let _ = PropVariantClear(&mut pv);
        s
    }

    unsafe fn prop_u32(store: &IPropertyStore, key: &PROPERTYKEY) -> Option<u32> {
        let mut pv = store.GetValue(key).ok()?;
        let v = if pv.Anonymous.Anonymous.vt == VT_EMPTY {
            None
        } else {
            PropVariantToUInt32(&pv).ok()
        };
        let _ = PropVariantClear(&mut pv);
        v
    }

    pub fn endpoint_state(id: &str) -> Result<&'static str, String> {
        if id.is_empty() {
            return Ok("missing");
        }
        let id = id.to_string();
        on_fresh_thread(move || unsafe {
            let _com = ComInit::mta().map_err(|e| err("CoInitializeEx", e))?;
            let en = enumerator().map_err(|e| err("CoCreateInstance(MMDeviceEnumerator)", e))?;
            let dev = match device_by_id(&en, &id) {
                Ok(d) => d,
                Err(e) if is_not_found(e.code().0 as u32) => return Ok("missing"),
                Err(e) => return Err(err("IMMDeviceEnumerator::GetDevice", e)),
            };
            let state = dev.GetState().map_err(|e| err("IMMDevice::GetState", e))?;
            Ok(state_to_str(state))
        })
    }
}
