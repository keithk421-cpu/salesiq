//! Pure mappings from Windows numeric values to the strings in the JS contract
//! (src/shared/nativeApi.ts). Unit-tested on every platform.

#![cfg_attr(not(windows), allow(dead_code))]

pub const DEVICE_STATE_ACTIVE: u32 = 0x1;
pub const DEVICE_STATE_DISABLED: u32 = 0x2;
pub const DEVICE_STATE_NOTPRESENT: u32 = 0x4;
pub const DEVICE_STATE_UNPLUGGED: u32 = 0x8;

pub const AUDCLNT_E_DEVICE_INVALIDATED: u32 = 0x8889_0004;
pub const AUDCLNT_E_DEVICE_IN_USE: u32 = 0x8889_000A;
/// HRESULT_FROM_WIN32(ERROR_NOT_FOUND) == E_NOTFOUND.
pub const E_NOTFOUND: u32 = 0x8007_0490;
pub const E_INVALIDARG: u32 = 0x8007_0057;

/// AUDCLNT_BUFFERFLAGS_*.
pub const BUFFERFLAGS_DATA_DISCONTINUITY: u32 = 0x1;
pub const BUFFERFLAGS_SILENT: u32 = 0x2;
pub const BUFFERFLAGS_TIMESTAMP_ERROR: u32 = 0x4;

/// DEVICE_STATE_* -> EndpointState string.
pub fn state_to_str(state: u32) -> &'static str {
    match state {
        DEVICE_STATE_ACTIVE => "active",
        DEVICE_STATE_DISABLED => "disabled",
        DEVICE_STATE_NOTPRESENT => "notpresent",
        DEVICE_STATE_UNPLUGGED => "unplugged",
        // Not a documented single state; treat as not usable.
        _ => "notpresent",
    }
}

/// EndpointFormFactor -> string.
pub fn form_factor_to_str(ff: u32) -> &'static str {
    match ff {
        0 => "remote_network_device",
        1 => "speakers",
        2 => "line_level",
        3 => "headphones",
        4 => "microphone",
        5 => "headset",
        6 => "handset",
        7 => "unknown_digital_passthrough",
        8 => "spdif",
        9 => "digital_audio_display_device",
        _ => "unknown",
    }
}

/// HRESULT -> NativeCaptureError.code. `fallback` is used for anything not
/// specifically recognised ('internal' inside the capture loop, 'open_failed'
/// while opening).
pub fn hresult_to_code(hr: u32, fallback: &'static str) -> &'static str {
    match hr {
        AUDCLNT_E_DEVICE_INVALIDATED => "device_invalidated",
        AUDCLNT_E_DEVICE_IN_USE => "exclusive_in_use",
        _ => fallback,
    }
}

pub fn hresult_hex(hr: u32) -> String {
    format!("0x{:08X}", hr)
}

pub fn is_not_found(hr: u32) -> bool {
    hr == E_NOTFOUND || hr == E_INVALIDARG
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states() {
        assert_eq!(state_to_str(1), "active");
        assert_eq!(state_to_str(2), "disabled");
        assert_eq!(state_to_str(4), "notpresent");
        assert_eq!(state_to_str(8), "unplugged");
        assert_eq!(state_to_str(0), "notpresent");
    }

    #[test]
    fn form_factors() {
        assert_eq!(form_factor_to_str(0), "remote_network_device");
        assert_eq!(form_factor_to_str(1), "speakers");
        assert_eq!(form_factor_to_str(3), "headphones");
        assert_eq!(form_factor_to_str(4), "microphone");
        assert_eq!(form_factor_to_str(5), "headset");
        assert_eq!(form_factor_to_str(8), "spdif");
        assert_eq!(form_factor_to_str(10), "unknown");
        assert_eq!(form_factor_to_str(99), "unknown");
    }

    #[test]
    fn hresults() {
        assert_eq!(hresult_to_code(0x8889_0004, "internal"), "device_invalidated");
        assert_eq!(hresult_to_code(0x8889_000A, "internal"), "exclusive_in_use");
        assert_eq!(hresult_to_code(0x8000_4005, "internal"), "internal");
        assert_eq!(hresult_to_code(0x8000_4005, "open_failed"), "open_failed");
        assert_eq!(hresult_hex(0x8889_0004), "0x88890004");
        assert!(is_not_found(0x8007_0490));
        assert!(!is_not_found(0x8889_0004));
    }
}
