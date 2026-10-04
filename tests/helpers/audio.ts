/** Synthetic 16 kHz Int16 PCM for tests. */
export function tone(samples: number, amp = 6000, freq = 300, phase0 = 0): Buffer {
  const b = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * (i + phase0)) / 16000) * amp), i * 2)
  return b
}

export function noise(samples: number, amp = 3000, seed = 1): Buffer {
  let s = seed
  const b = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    b.writeInt16LE(Math.round(((s / 0x7fffffff) * 2 - 1) * amp), i * 2)
  }
  return b
}

export function zeros(samples: number): Buffer {
  return Buffer.alloc(samples * 2)
}
