//! Platform-independent audio processing: WAVEFORMATEX(TENSIBLE) parsing,
//! sample decoding, mono downmix, resampling to 16 kHz and the output
//! timeline (QPC anchoring, discontinuities, loopback idle fill).
//!
//! The resampler setup and f32 -> i16 conversion are adapted from Project Raven
//! (MIT, Copyright (c) 2026 Laxcorp Software Design - FZCO), commit
//! 692cd17606e9f2d0063e2c32c9e250eaa5f60ddc, src/native/windows/src/wasapi.rs.
//! Changes from Raven: correct integer-vs-float format detection (Raven treated
//! every 32-bit format as float), 24-bit packed support, delay-compensated
//! QPC timestamps, discontinuity pass-through and synthetic idle silence.
//!
//! Everything here is pure Rust so it is unit-tested on Linux.

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub const TARGET_SAMPLE_RATE: u32 = 16_000;
/// Output samples per millisecond at the target rate.
const TARGET_SAMPLES_PER_MS: f64 = TARGET_SAMPLE_RATE as f64 / 1000.0;
const RESAMPLE_CHUNK_SIZE: usize = 1024;

/// Loopback idle fill: synthesize silence once the timeline is this far behind "now".
pub const IDLE_FILL_THRESHOLD_MS: f64 = 60.0;
/// Synthetic silence stops this far short of "now", so a packet that is just
/// arriving (its first frame was captured slightly in the past) does not land
/// on top of synthesized zeros.
pub const IDLE_FILL_LAG_MS: f64 = 30.0;
/// Maximum synthetic silence per poll.
pub const IDLE_FILL_CAP_MS: f64 = 1000.0;
/// If a packet's QPC time deviates from the running sample-counter clock by
/// more than this, the segment is re-anchored to the packet's QPC time
/// (covers loopback pauses without a discontinuity flag and clock drift).
pub const REANCHOR_TOLERANCE_MS: f64 = 30.0;

// ---------------------------------------------------------------------------
// Format parsing
// ---------------------------------------------------------------------------

pub const WAVE_FORMAT_PCM: u16 = 0x0001;
pub const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
pub const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// KSDATAFORMAT_SUBTYPE_PCM {00000001-0000-0010-8000-00aa00389b71}, in memory (LE) byte order.
pub const KSDATAFORMAT_SUBTYPE_PCM_BYTES: [u8; 16] = [
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];
/// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {00000003-0000-0010-8000-00aa00389b71}, in memory (LE) byte order.
pub const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_BYTES: [u8; 16] = [
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

/// Size of WAVEFORMATEX (packed).
pub const WAVEFORMATEX_SIZE: usize = 18;
/// Size of WAVEFORMATEXTENSIBLE (packed).
pub const WAVEFORMATEXTENSIBLE_SIZE: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Pcm,
    Float,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleFormat {
    F32,
    I16,
    /// Packed 3-byte little-endian signed.
    I24,
    I32,
}

impl SampleFormat {
    pub fn bytes(self) -> usize {
        match self {
            SampleFormat::I16 => 2,
            SampleFormat::I24 => 3,
            SampleFormat::F32 | SampleFormat::I32 => 4,
        }
    }
}

/// What we learned from a WAVEFORMATEX / WAVEFORMATEXTENSIBLE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WaveFormatInfo {
    pub format_tag: u16,
    pub sample_rate: u32,
    pub channels: u16,
    /// Container size per sample (wBitsPerSample).
    pub bits_per_sample: u16,
    /// wValidBitsPerSample for EXTENSIBLE, else bits_per_sample.
    pub valid_bits: u16,
    pub block_align: u16,
    pub encoding: Encoding,
}

impl WaveFormatInfo {
    pub fn is_float(&self) -> bool {
        self.encoding == Encoding::Float
    }

    /// The sample decoder for this format, or a human-readable reason why it is unsupported.
    pub fn sample_format(&self) -> Result<SampleFormat, String> {
        if self.channels == 0 {
            return Err("mix format has 0 channels".into());
        }
        if self.sample_rate == 0 {
            return Err("mix format has sample rate 0".into());
        }
        let fmt = match (self.encoding, self.bits_per_sample) {
            (Encoding::Float, 32) => SampleFormat::F32,
            (Encoding::Pcm, 16) => SampleFormat::I16,
            (Encoding::Pcm, 24) => SampleFormat::I24,
            // 32-bit container covers both 32-bit and 24-in-32 (left-justified) integer PCM.
            (Encoding::Pcm, 32) => SampleFormat::I32,
            (enc, bits) => {
                return Err(format!(
                    "unsupported sample format: tag=0x{:04X} encoding={:?} bits={}",
                    self.format_tag, enc, bits
                ))
            }
        };
        let min_align = fmt.bytes() * self.channels as usize;
        if (self.block_align as usize) < min_align {
            return Err(format!(
                "block align {} too small for {} channels of {} bytes",
                self.block_align,
                self.channels,
                fmt.bytes()
            ));
        }
        Ok(fmt)
    }
}

/// Parse a WAVEFORMATEX (optionally followed by the WAVEFORMATEXTENSIBLE tail)
/// from raw little-endian bytes. `raw` must hold at least 18 bytes, and 40 for
/// an EXTENSIBLE format.
pub fn parse_wave_format(raw: &[u8]) -> Result<WaveFormatInfo, String> {
    if raw.len() < WAVEFORMATEX_SIZE {
        return Err(format!("WAVEFORMATEX too short: {} bytes", raw.len()));
    }
    let u16_at = |o: usize| u16::from_le_bytes([raw[o], raw[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes([raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]);
    let format_tag = u16_at(0);
    let channels = u16_at(2);
    let sample_rate = u32_at(4);
    let block_align = u16_at(12);
    let bits_per_sample = u16_at(14);
    let cb_size = u16_at(16);

    let (encoding, valid_bits) = match format_tag {
        WAVE_FORMAT_PCM => (Encoding::Pcm, bits_per_sample),
        WAVE_FORMAT_IEEE_FLOAT => (Encoding::Float, bits_per_sample),
        WAVE_FORMAT_EXTENSIBLE => {
            if (cb_size as usize) < WAVEFORMATEXTENSIBLE_SIZE - WAVEFORMATEX_SIZE
                || raw.len() < WAVEFORMATEXTENSIBLE_SIZE
            {
                return Err(format!(
                    "WAVE_FORMAT_EXTENSIBLE with short extension (cbSize={})",
                    cb_size
                ));
            }
            let valid = u16_at(18);
            let sub: &[u8] = &raw[24..40];
            let enc = if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_BYTES {
                Encoding::Float
            } else if sub == KSDATAFORMAT_SUBTYPE_PCM_BYTES {
                Encoding::Pcm
            } else {
                Encoding::Other
            };
            (enc, if valid == 0 { bits_per_sample } else { valid })
        }
        _ => (Encoding::Other, bits_per_sample),
    };

    Ok(WaveFormatInfo {
        format_tag,
        sample_rate,
        channels,
        bits_per_sample,
        valid_bits,
        block_align,
        encoding,
    })
}

// ---------------------------------------------------------------------------
// Sample conversion
// ---------------------------------------------------------------------------

#[inline]
pub fn f32_sample(b: &[u8]) -> f32 {
    f32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

#[inline]
pub fn i16_sample(b: &[u8]) -> f32 {
    i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0
}

#[inline]
pub fn i24_sample(b: &[u8]) -> f32 {
    // Sign-extend the top byte.
    let v = (b[0] as i32) | ((b[1] as i32) << 8) | (((b[2] as i8) as i32) << 16);
    v as f32 / 8_388_608.0
}

#[inline]
pub fn i32_sample(b: &[u8]) -> f32 {
    (i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64 / 2_147_483_648.0) as f32
}

#[inline]
pub fn decode_sample(fmt: SampleFormat, b: &[u8]) -> f32 {
    match fmt {
        SampleFormat::F32 => f32_sample(b),
        SampleFormat::I16 => i16_sample(b),
        SampleFormat::I24 => i24_sample(b),
        SampleFormat::I32 => i32_sample(b),
    }
}

/// Decode interleaved frames and downmix to mono by averaging channels.
/// Trailing bytes that do not form a whole frame are ignored.
pub fn decode_to_mono(bytes: &[u8], fmt: SampleFormat, channels: usize, block_align: usize) -> Vec<f32> {
    if channels == 0 || block_align == 0 {
        return Vec::new();
    }
    let sb = fmt.bytes();
    let inv = 1.0 / channels as f32;
    bytes
        .chunks_exact(block_align)
        .map(|frame| {
            let mut sum = 0.0f32;
            for ch in 0..channels {
                let o = ch * sb;
                sum += decode_sample(fmt, &frame[o..o + sb]);
            }
            sum * inv
        })
        .collect()
}

/// Average interleaved f32 channels into mono.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    interleaved
        .chunks_exact(channels)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect()
}

#[inline]
pub fn f32_to_i16(s: f32) -> i16 {
    // NaN -> 0 (saturating `as` cast), out-of-range clamped.
    (s.clamp(-1.0, 1.0) * 32_767.0).round() as i16
}

pub fn f32_to_i16_le_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        out.extend_from_slice(&f32_to_i16(s).to_le_bytes());
    }
    out
}

// ---------------------------------------------------------------------------
// Resampling + timeline
// ---------------------------------------------------------------------------

/// One 16 kHz mono chunk ready to hand to JS.
#[derive(Debug, Clone, PartialEq)]
pub struct OutChunk {
    pub samples: Vec<f32>,
    pub monotonic_ms: f64,
    pub discontinuity: bool,
    pub synthetic_silence: bool,
}

impl OutChunk {
    pub fn to_i16_le(&self) -> Vec<u8> {
        f32_to_i16_le_bytes(&self.samples)
    }
}

struct ResampleState {
    resampler: SincFixedIn<f32>,
    pending: Vec<f32>,
    /// Output samples still to discard to compensate the filter delay.
    skip: usize,
}

impl ResampleState {
    fn new(source_rate: u32) -> Result<Self, String> {
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };
        let resampler = SincFixedIn::<f32>::new(
            TARGET_SAMPLE_RATE as f64 / source_rate as f64,
            2.0,
            params,
            RESAMPLE_CHUNK_SIZE,
            1,
        )
        .map_err(|e| format!("failed to create resampler: {e}"))?;
        let skip = resampler.output_delay();
        Ok(ResampleState {
            resampler,
            pending: Vec::with_capacity(RESAMPLE_CHUNK_SIZE * 2),
            skip,
        })
    }

    fn run_chunk(&mut self, chunk: &[f32], out: &mut Vec<f32>) {
        match self.resampler.process(&[chunk], None) {
            Ok(mut res) => {
                let mut ch = res.pop().unwrap_or_default();
                if self.skip > 0 {
                    let n = self.skip.min(ch.len());
                    ch.drain(..n);
                    self.skip -= n;
                }
                out.extend_from_slice(&ch);
            }
            Err(e) => eprintln!("[sales-copilot-audio] resample error: {e:?}"),
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        self.pending.extend_from_slice(input);
        let mut out = Vec::new();
        let mut consumed = 0;
        while self.pending.len() - consumed >= RESAMPLE_CHUNK_SIZE {
            let chunk: Vec<f32> = self.pending[consumed..consumed + RESAMPLE_CHUNK_SIZE].to_vec();
            self.run_chunk(&chunk, &mut out);
            consumed += RESAMPLE_CHUNK_SIZE;
        }
        self.pending.drain(..consumed);
        out
    }

    /// Push zeros through until at least `need` more output samples exist.
    fn drain(&mut self, need: usize) -> Vec<f32> {
        let mut out = Vec::new();
        // The delay plus one partial chunk is at most a few chunks; bound the loop anyway.
        for _ in 0..16 {
            if out.len() >= need {
                break;
            }
            let mut chunk = std::mem::take(&mut self.pending);
            chunk.resize(RESAMPLE_CHUNK_SIZE, 0.0);
            self.run_chunk(&chunk, &mut out);
        }
        out.truncate(need);
        out
    }
}

/// Converts mono packets at the device rate into 16 kHz chunks stamped on the
/// QPC millisecond clock.
///
/// A *segment* is a run of input anchored at one QPC time: output sample `n`
/// of the segment is stamped `anchor_ms + n / 16`. The resampler's filter delay
/// is removed so that holds exactly. A new segment starts on the first packet,
/// after a WASAPI discontinuity, after idle fill, and when packet QPC times
/// stray from the sample-counter clock by more than REANCHOR_TOLERANCE_MS.
pub struct Pipeline {
    source_rate: u32,
    rs: Option<ResampleState>,
    /// QPC ms of output sample 0 of the current segment; None = no active segment.
    anchor_ms: Option<f64>,
    /// Output samples emitted in the current segment.
    emitted: u64,
    /// Input frames fed in the current segment.
    fed_frames: u64,
    /// End (QPC ms) of the last audio emitted, real or synthetic.
    last_end_ms: Option<f64>,
    pending_discontinuity: bool,
}

impl Pipeline {
    pub fn new(source_rate: u32) -> Result<Self, String> {
        if source_rate == 0 {
            return Err("sample rate 0".into());
        }
        // Validate that the resampler can be built for this rate up front.
        if source_rate != TARGET_SAMPLE_RATE {
            ResampleState::new(source_rate)?;
        }
        Ok(Pipeline {
            source_rate,
            rs: None,
            anchor_ms: None,
            emitted: 0,
            fed_frames: 0,
            last_end_ms: None,
            pending_discontinuity: false,
        })
    }

    /// Set the timeline origin (stream start time) used by idle fill before
    /// any audio has been emitted.
    pub fn set_origin(&mut self, now_ms: f64) {
        if self.last_end_ms.is_none() {
            self.last_end_ms = Some(now_ms);
        }
    }

    pub fn last_end_ms(&self) -> Option<f64> {
        self.last_end_ms
    }

    fn segment_ms(&self, out_samples: u64) -> f64 {
        self.anchor_ms.unwrap_or(0.0) + out_samples as f64 / TARGET_SAMPLES_PER_MS
    }

    /// QPC time just past the last input frame fed in the current segment.
    fn input_end_ms(&self) -> Option<f64> {
        self.anchor_ms
            .map(|a| a + self.fed_frames as f64 * 1000.0 / self.source_rate as f64)
    }

    fn make_chunk(&mut self, samples: Vec<f32>, out: &mut Vec<OutChunk>) {
        if samples.is_empty() {
            return;
        }
        let monotonic_ms = self.segment_ms(self.emitted);
        self.emitted += samples.len() as u64;
        self.last_end_ms = Some(self.segment_ms(self.emitted));
        out.push(OutChunk {
            samples,
            monotonic_ms,
            discontinuity: std::mem::take(&mut self.pending_discontinuity),
            synthetic_silence: false,
        });
    }

    /// End the current segment: emit every output sample that corresponds to
    /// real input still inside the resampler, then reset it.
    pub fn flush(&mut self) -> Vec<OutChunk> {
        let mut out = Vec::new();
        if self.anchor_ms.is_none() {
            return out;
        }
        if let Some(mut rs) = self.rs.take() {
            let target_total = (self.fed_frames as f64 * TARGET_SAMPLE_RATE as f64
                / self.source_rate as f64)
                .round() as u64;
            let need = target_total.saturating_sub(self.emitted) as usize;
            if need > 0 {
                let tail = rs.drain(need);
                self.make_chunk(tail, &mut out);
            }
        }
        self.anchor_ms = None;
        self.emitted = 0;
        self.fed_frames = 0;
        out
    }

    fn start_segment(&mut self, anchor_ms: f64) -> Result<(), String> {
        self.anchor_ms = Some(anchor_ms);
        self.emitted = 0;
        self.fed_frames = 0;
        self.rs = if self.source_rate != TARGET_SAMPLE_RATE {
            Some(ResampleState::new(self.source_rate)?)
        } else {
            None
        };
        Ok(())
    }

    /// Feed one WASAPI packet (already decoded to mono f32 at the source rate).
    /// `qpc_ms` is the packet's QPC time (None when WASAPI flagged a timestamp
    /// error); `discontinuity` is AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.
    pub fn push(&mut self, mono: &[f32], qpc_ms: Option<f64>, discontinuity: bool) -> Result<Vec<OutChunk>, String> {
        let mut out = Vec::new();
        if discontinuity {
            out.extend(self.flush());
            self.pending_discontinuity = true;
        }
        if mono.is_empty() {
            return Ok(out);
        }

        // Re-anchor if the packet's QPC time strays from the sample clock.
        if let (Some(expected), Some(t)) = (self.input_end_ms(), qpc_ms) {
            if (t - expected).abs() > REANCHOR_TOLERANCE_MS {
                out.extend(self.flush());
            }
        }

        let mut input = mono;
        if self.anchor_ms.is_none() {
            let mut t = qpc_ms.or(self.last_end_ms).unwrap_or(0.0);
            // Never overlap audio already emitted: drop leading input that falls
            // before the end of the previous output.
            if let Some(prev_end) = self.last_end_ms {
                if t < prev_end {
                    let trim = (((prev_end - t) * self.source_rate as f64 / 1000.0).ceil() as usize)
                        .min(input.len());
                    input = &input[trim..];
                    t += trim as f64 * 1000.0 / self.source_rate as f64;
                }
            }
            if input.is_empty() {
                return Ok(out);
            }
            self.start_segment(t)?;
        }

        self.fed_frames += input.len() as u64;
        let resampled = match self.rs.as_mut() {
            Some(rs) => rs.process(input),
            None => input.to_vec(),
        };
        self.make_chunk(resampled, &mut out);
        Ok(out)
    }

    /// Loopback idle handling, called when a poll delivered no packets.
    /// Flushes a stalled segment and synthesizes zeros so the timeline stays
    /// continuous.
    pub fn idle_tick(&mut self, now_ms: f64) -> Vec<OutChunk> {
        let mut out = Vec::new();
        if let Some(input_end) = self.input_end_ms() {
            if now_ms - input_end > IDLE_FILL_THRESHOLD_MS {
                out.extend(self.flush());
            } else {
                return out; // segment still live; packets may just be late
            }
        }
        let Some(last_end) = self.last_end_ms else {
            self.last_end_ms = Some(now_ms);
            return out;
        };
        if now_ms - last_end <= IDLE_FILL_THRESHOLD_MS {
            return out;
        }
        let gap_ms = (now_ms - IDLE_FILL_LAG_MS - last_end).min(IDLE_FILL_CAP_MS);
        let n = (gap_ms * TARGET_SAMPLES_PER_MS).floor();
        if n < 1.0 {
            return out;
        }
        let n = n as usize;
        self.last_end_ms = Some(last_end + n as f64 / TARGET_SAMPLES_PER_MS);
        out.push(OutChunk {
            samples: vec![0.0; n],
            monotonic_ms: last_end,
            discontinuity: false,
            synthetic_silence: true,
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn f32_decode() {
        assert!(approx(f32_sample(&0.5f32.to_le_bytes()), 0.5));
        assert!(approx(f32_sample(&(-1.0f32).to_le_bytes()), -1.0));
    }

    #[test]
    fn i16_decode() {
        assert!(approx(i16_sample(&0i16.to_le_bytes()), 0.0));
        assert!(approx(i16_sample(&i16::MIN.to_le_bytes()), -1.0));
        assert!(approx(i16_sample(&16384i16.to_le_bytes()), 0.5));
        assert!(i16_sample(&i16::MAX.to_le_bytes()) < 1.0);
    }

    #[test]
    fn i24_decode() {
        // +0.5 = 0x400000
        assert!(approx(i24_sample(&[0x00, 0x00, 0x40]), 0.5));
        // -1.0 = 0x800000
        assert!(approx(i24_sample(&[0x00, 0x00, 0x80]), -1.0));
        // -1 LSB = 0xFFFFFF
        assert!(approx(i24_sample(&[0xFF, 0xFF, 0xFF]), -1.0 / 8_388_608.0));
        assert!(approx(i24_sample(&[0x01, 0x00, 0x00]), 1.0 / 8_388_608.0));
    }

    #[test]
    fn i32_decode_is_integer_not_float() {
        // Raven's bug: 32-bit int interpreted as float. 0x40000000 as int = 0.5,
        // as float bits it would be 2.0.
        assert!(approx(i32_sample(&0x4000_0000i32.to_le_bytes()), 0.5));
        assert!(approx(i32_sample(&i32::MIN.to_le_bytes()), -1.0));
        assert!(approx(i32_sample(&0i32.to_le_bytes()), 0.0));
    }

    #[test]
    fn decode_to_mono_averages_channels() {
        let mut bytes = Vec::new();
        for (l, r) in [(1.0f32, 0.0f32), (0.5, -0.5), (-1.0, -0.5)] {
            bytes.extend_from_slice(&l.to_le_bytes());
            bytes.extend_from_slice(&r.to_le_bytes());
        }
        let m = decode_to_mono(&bytes, SampleFormat::F32, 2, 8);
        assert_eq!(m.len(), 3);
        assert!(approx(m[0], 0.5));
        assert!(approx(m[1], 0.0));
        assert!(approx(m[2], -0.75));

        // 24-bit packed stereo, block align 6
        let bytes = [0x00, 0x00, 0x40, 0x00, 0x00, 0x00];
        let m = decode_to_mono(&bytes, SampleFormat::I24, 2, 6);
        assert_eq!(m.len(), 1);
        assert!(approx(m[0], 0.25));

        // Trailing partial frame ignored
        let m = decode_to_mono(&[0, 0, 0], SampleFormat::I16, 1, 2);
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn downmix_averages() {
        let m = downmix(&[1.0, 0.0, 0.0, 1.0, 0.5, 0.5], 3);
        assert_eq!(m.len(), 2);
        assert!(approx(m[0], 1.0 / 3.0));
        assert!(approx(m[1], 2.0 / 3.0));
        assert_eq!(downmix(&[0.1, 0.2], 1), vec![0.1, 0.2]);
    }

    #[test]
    fn f32_to_i16_clamps() {
        assert_eq!(f32_to_i16(0.0), 0);
        assert_eq!(f32_to_i16(1.0), 32767);
        assert_eq!(f32_to_i16(2.5), 32767);
        assert_eq!(f32_to_i16(-1.0), -32767);
        assert_eq!(f32_to_i16(-7.0), -32767);
        assert_eq!(f32_to_i16(f32::NAN), 0);
        assert_eq!(f32_to_i16_le_bytes(&[1.0, -1.0]), vec![0xFF, 0x7F, 0x01, 0x80]);
    }

    fn wfx(tag: u16, ch: u16, rate: u32, bits: u16, cb: u16) -> Vec<u8> {
        let align = ch * bits / 8;
        let mut v = Vec::new();
        v.extend_from_slice(&tag.to_le_bytes());
        v.extend_from_slice(&ch.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * align as u32).to_le_bytes());
        v.extend_from_slice(&align.to_le_bytes());
        v.extend_from_slice(&bits.to_le_bytes());
        v.extend_from_slice(&cb.to_le_bytes());
        v
    }

    fn wfx_ext(ch: u16, rate: u32, bits: u16, valid: u16, sub: [u8; 16]) -> Vec<u8> {
        let mut v = wfx(WAVE_FORMAT_EXTENSIBLE, ch, rate, bits, 22);
        v.extend_from_slice(&valid.to_le_bytes());
        v.extend_from_slice(&3u32.to_le_bytes()); // channel mask
        v.extend_from_slice(&sub);
        v
    }

    #[test]
    fn parse_formats() {
        let f = parse_wave_format(&wfx(WAVE_FORMAT_IEEE_FLOAT, 2, 48000, 32, 0)).unwrap();
        assert_eq!(f.sample_format().unwrap(), SampleFormat::F32);
        assert!(f.is_float());

        let f = parse_wave_format(&wfx(WAVE_FORMAT_PCM, 1, 44100, 16, 0)).unwrap();
        assert_eq!(f.sample_format().unwrap(), SampleFormat::I16);

        let f = parse_wave_format(&wfx_ext(2, 48000, 32, 32, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_BYTES)).unwrap();
        assert_eq!(f.sample_format().unwrap(), SampleFormat::F32);

        // 32-bit integer EXTENSIBLE must NOT be treated as float.
        let f = parse_wave_format(&wfx_ext(2, 48000, 32, 32, KSDATAFORMAT_SUBTYPE_PCM_BYTES)).unwrap();
        assert!(!f.is_float());
        assert_eq!(f.sample_format().unwrap(), SampleFormat::I32);

        // 24-in-32 integer container
        let f = parse_wave_format(&wfx_ext(2, 48000, 32, 24, KSDATAFORMAT_SUBTYPE_PCM_BYTES)).unwrap();
        assert_eq!(f.valid_bits, 24);
        assert_eq!(f.sample_format().unwrap(), SampleFormat::I32);

        let f = parse_wave_format(&wfx_ext(2, 96000, 24, 24, KSDATAFORMAT_SUBTYPE_PCM_BYTES)).unwrap();
        assert_eq!(f.sample_format().unwrap(), SampleFormat::I24);

        // Unsupported: 8-bit, 64-bit float, unknown subformat, unknown tag
        assert!(parse_wave_format(&wfx(WAVE_FORMAT_PCM, 1, 8000, 8, 0)).unwrap().sample_format().is_err());
        assert!(parse_wave_format(&wfx(WAVE_FORMAT_IEEE_FLOAT, 1, 8000, 64, 0)).unwrap().sample_format().is_err());
        let mut odd = KSDATAFORMAT_SUBTYPE_PCM_BYTES;
        odd[0] = 0x92;
        assert!(parse_wave_format(&wfx_ext(2, 48000, 16, 16, odd)).unwrap().sample_format().is_err());
        assert!(parse_wave_format(&wfx(0x0055, 2, 48000, 16, 0)).unwrap().sample_format().is_err());
        // Truncated
        assert!(parse_wave_format(&[0u8; 10]).is_err());
        assert!(parse_wave_format(&wfx(WAVE_FORMAT_EXTENSIBLE, 2, 48000, 32, 0)).is_err());
    }

    #[test]
    fn passthrough_16k_timeline() {
        let mut p = Pipeline::new(16000).unwrap();
        let a = p.push(&[0.1; 160], Some(1000.0), false).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].samples.len(), 160);
        assert_eq!(a[0].monotonic_ms, 1000.0);
        let b = p.push(&[0.1; 160], Some(1010.0), false).unwrap();
        assert_eq!(b[0].monotonic_ms, 1010.0);
        assert_eq!(p.last_end_ms(), Some(1020.0));
    }

    #[test]
    fn discontinuity_flag_passes_to_next_chunk() {
        let mut p = Pipeline::new(16000).unwrap();
        p.push(&[0.0; 160], Some(0.0), false).unwrap();
        let c = p.push(&[0.0; 160], Some(500.0), true).unwrap();
        assert_eq!(c.len(), 1);
        assert!(c[0].discontinuity);
        assert_eq!(c[0].monotonic_ms, 500.0);
        let d = p.push(&[0.0; 160], Some(510.0), false).unwrap();
        assert!(!d[0].discontinuity);
    }

    #[test]
    fn resampled_48k_counts_and_timestamps() {
        let mut p = Pipeline::new(48000).unwrap();
        let mut chunks = Vec::new();
        let mut t = 100.0;
        // 1 second of 10 ms packets
        for _ in 0..100 {
            chunks.extend(p.push(&[0.25; 480], Some(t), false).unwrap());
            t += 10.0;
        }
        let total: usize = chunks.iter().map(|c| c.samples.len()).sum();
        // Delay compensated: slightly less than 16000 until flushed.
        assert!(total > 15000 && total <= 16000, "total {total}");
        assert_eq!(chunks[0].monotonic_ms, 100.0);
        // Timestamps are contiguous.
        let mut expect = 100.0;
        for c in &chunks {
            assert!((c.monotonic_ms - expect).abs() < 1e-9);
            expect += c.samples.len() as f64 / 16.0;
        }
        chunks.extend(p.flush());
        let total: usize = chunks.iter().map(|c| c.samples.len()).sum();
        assert_eq!(total, 16000);
        // DC level preserved in the middle.
        let mid = &chunks[chunks.len() / 2].samples;
        assert!((mid[mid.len() / 2] - 0.25).abs() < 0.01);
    }

    #[test]
    fn idle_fill_synthesizes_silence() {
        let mut p = Pipeline::new(16000).unwrap();
        p.set_origin(0.0);
        assert!(p.idle_tick(50.0).is_empty());
        let c = p.idle_tick(100.0);
        assert_eq!(c.len(), 1);
        assert!(c[0].synthetic_silence);
        assert_eq!(c[0].monotonic_ms, 0.0);
        assert_eq!(c[0].samples.len(), 70 * 16); // up to now - lag
        assert_eq!(p.last_end_ms(), Some(70.0));
        // Cap at 1000 ms
        let c = p.idle_tick(5000.0);
        assert_eq!(c[0].samples.len(), 16000);
        assert_eq!(c[0].monotonic_ms, 70.0);
    }

    #[test]
    fn idle_fill_flushes_segment_then_fills_and_real_audio_does_not_overlap() {
        let mut p = Pipeline::new(48000).unwrap();
        p.set_origin(0.0);
        let mut chunks = Vec::new();
        chunks.extend(p.push(&[0.0; 480], Some(0.0), false).unwrap());
        // Segment still live shortly after.
        assert!(p.idle_tick(40.0).is_empty());
        // Stalled: flush real remainder (10 ms = 160 samples total) then fill.
        let c = p.idle_tick(200.0);
        chunks.extend(c.clone());
        let real: usize = chunks.iter().filter(|c| !c.synthetic_silence).map(|c| c.samples.len()).sum();
        assert_eq!(real, 160);
        let syn: Vec<_> = c.iter().filter(|c| c.synthetic_silence).collect();
        assert_eq!(syn.len(), 1);
        assert_eq!(syn[0].monotonic_ms, 10.0);
        let end = p.last_end_ms().unwrap();
        assert!((end - 170.0).abs() < 1e-9);
        // A real packet whose QPC time is before the synthetic end gets trimmed.
        let r = p.push(&[0.0; 4800], Some(160.0), false).unwrap();
        if let Some(first) = r.first() {
            assert!(first.monotonic_ms >= end - 1e-9);
        }
    }

    #[test]
    fn reanchors_on_qpc_jump() {
        let mut p = Pipeline::new(16000).unwrap();
        p.push(&[0.0; 160], Some(0.0), false).unwrap();
        let c = p.push(&[0.0; 160], Some(300.0), false).unwrap();
        assert_eq!(c.last().unwrap().monotonic_ms, 300.0);
        assert!(!c.last().unwrap().discontinuity);
    }
}
