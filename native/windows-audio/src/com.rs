//! Small RAII helpers around COM / Core Audio (Windows only).
//!
//! Read-only: nothing here writes Windows audio configuration. Endpoints are
//! opened by explicit ID only (IMMDeviceEnumerator::GetDevice).

use std::ffi::c_void;

use windows::core::{ComInterface, Error, Result, HSTRING, PWSTR};
use windows::Win32::Foundation::E_INVALIDARG;
use windows::Win32::Media::Audio::{
    eCapture, eRender, EDataFlow, IAudioClient, IMMDevice, IMMDeviceEnumerator, IMMEndpoint,
    MMDeviceEnumerator, WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

use crate::dsp::{parse_wave_format, WaveFormatInfo, WAVEFORMATEXTENSIBLE_SIZE, WAVEFORMATEX_SIZE};

/// CoInitializeEx(MTA) for the current thread; CoUninitialize on drop.
/// Must be created before, and dropped after, every COM object on the thread.
pub struct ComInit(());

impl ComInit {
    pub fn mta() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED)? };
        Ok(ComInit(()))
    }
}

impl Drop for ComInit {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// Take ownership of a CoTaskMemAlloc'd wide string: copy it and free it.
pub unsafe fn take_co_wstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as *const c_void));
    s
}

/// GetMixFormat result; freed with CoTaskMemFree on drop.
pub struct CoMixFormat(*mut WAVEFORMATEX);

impl CoMixFormat {
    pub unsafe fn get(client: &IAudioClient) -> Result<Self> {
        let p = client.GetMixFormat()?;
        if p.is_null() {
            return Err(Error::from(E_INVALIDARG));
        }
        Ok(CoMixFormat(p))
    }

    pub fn as_ptr(&self) -> *const WAVEFORMATEX {
        self.0
    }

    /// Parse the format. Reads only within the allocation (18 + cbSize bytes).
    pub fn info(&self) -> std::result::Result<WaveFormatInfo, String> {
        unsafe {
            let head = std::slice::from_raw_parts(self.0 as *const u8, WAVEFORMATEX_SIZE);
            let cb = u16::from_le_bytes([head[16], head[17]]) as usize;
            let len = (WAVEFORMATEX_SIZE + cb).min(WAVEFORMATEXTENSIBLE_SIZE);
            parse_wave_format(std::slice::from_raw_parts(self.0 as *const u8, len))
        }
    }
}

impl Drop for CoMixFormat {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0 as *const c_void)) };
    }
}

pub unsafe fn enumerator() -> Result<IMMDeviceEnumerator> {
    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
}

/// Open an endpoint by its explicit ID. Never falls back to a default endpoint.
pub unsafe fn device_by_id(en: &IMMDeviceEnumerator, id: &str) -> Result<IMMDevice> {
    en.GetDevice(&HSTRING::from(id))
}

pub unsafe fn device_id(dev: &IMMDevice) -> Result<String> {
    Ok(take_co_wstr(dev.GetId()?))
}

pub unsafe fn device_flow(dev: &IMMDevice) -> Result<EDataFlow> {
    dev.cast::<IMMEndpoint>()?.GetDataFlow()
}

pub fn flow_to_str(flow: EDataFlow) -> &'static str {
    if flow == eRender {
        "render"
    } else if flow == eCapture {
        "capture"
    } else {
        "unknown"
    }
}
