//! Monotonic millisecond clock shared by `monotonicNowMs()` and chunk timestamps.
//!
//! WASAPI's `IAudioCaptureClient::GetBuffer` returns `pu64QPCPosition` as the
//! QueryPerformanceCounter value converted to 100 ns units. `monotonicNowMs()`
//! reads QueryPerformanceCounter directly and converts with the same scale, so
//! both are milliseconds on the same QPC timeline.

#![cfg_attr(not(windows), allow(dead_code))]

/// QPC ticks -> milliseconds, without losing precision for large counters.
pub fn qpc_ticks_to_ms(ticks: i64, freq: i64) -> f64 {
    if freq <= 0 {
        return 0.0;
    }
    let whole = ticks / freq;
    let rem = ticks % freq;
    whole as f64 * 1000.0 + rem as f64 * 1000.0 / freq as f64
}

/// WASAPI QPC position (100 ns units) -> milliseconds.
pub fn hns_to_ms(hns: u64) -> f64 {
    hns as f64 / 10_000.0
}

#[cfg(windows)]
pub fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    static FREQ: OnceLock<i64> = OnceLock::new();
    let freq = *FREQ.get_or_init(|| {
        let mut f = 0i64;
        // Cannot fail on Windows XP and later.
        let _ = unsafe { QueryPerformanceFrequency(&mut f) };
        f
    });
    let mut c = 0i64;
    let _ = unsafe { QueryPerformanceCounter(&mut c) };
    qpc_ticks_to_ms(c, freq)
}

/// Non-Windows fallback (dev/test only): process-relative monotonic ms.
#[cfg(not(windows))]
pub fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions() {
        assert_eq!(qpc_ticks_to_ms(10_000_000, 10_000_000), 1000.0);
        assert_eq!(qpc_ticks_to_ms(15_000_000, 10_000_000), 1500.0);
        assert_eq!(qpc_ticks_to_ms(5, 0), 0.0);
        // QPC at 10 MHz: 100 ns ticks == WASAPI hns units.
        assert_eq!(hns_to_ms(15_000_000), qpc_ticks_to_ms(15_000_000, 10_000_000));
        // Large counter (weeks of uptime) keeps sub-ms precision.
        let t = qpc_ticks_to_ms(i64::MAX / 4, 3_000_000);
        assert!(t.is_finite() && t > 0.0);
        let a = now_ms();
        let b = now_ms();
        assert!(b >= a);
    }
}
