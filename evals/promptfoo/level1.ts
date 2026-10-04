/** promptfoo javascript assertion: Level 1 correctness (hard gate), computed by the shared runner. */
export default function level1(_output: string, context: { providerResponse?: { metadata?: { result?: { level1: { pass: boolean; failures: string[] }; first_usable_ms: number | null } } } }) {
  const r = context.providerResponse?.metadata?.result
  if (!r) return { pass: false, score: 0, reason: 'no result from provider' }
  return {
    pass: r.level1.pass,
    score: r.level1.pass ? 1 : 0,
    reason: r.level1.pass ? `Level 1 ok (first usable ${r.first_usable_ms ?? '-'} ms)` : r.level1.failures.join('; '),
  }
}
