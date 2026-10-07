/**
 * What the price check (protocol.ts priceFigures) needs from the call, as at the press (M5 step 0):
 * the context's sources (an approved item's text backs a figure the card cites), the other side's
 * words from the last 30 s (Keith may ask their own figure back), and the call type then (pricing
 * calls check harder). Everything comes from the request's own context and the call's turns, so the
 * live card, the streaming check and the speed test all judge a line the same way. Nothing here is
 * logged or stored.
 */
import type { CallMemory } from './callMemory'
import { HOT_WINDOW_MS, type BuiltContext } from './context'
import type { PriceCheckOpts } from './protocol'

export function priceCheckInputs(memory: CallMemory, ctx: BuiltContext): PriceCheckOpts {
  const atMs = ctx.refs.at_session_ms
  // Their side: meeting audio, except a tagged Arize teammate (the SA's figures are not theirs to ask back).
  const theirs = memory.turnsAsOf(atMs).filter((t) => memory.fromTheirSide(t) && t.end_ms >= atMs - HOT_WINDOW_MS)
  return {
    sources: ctx.sources,
    theirRecentText: theirs.map((t) => t.text).join('\n'),
    // The type the request was built with (Keith can change it mid-call); older contexts don't carry it.
    callType: ctx.refs.call_setup?.call_type ?? memory.setup.call_type,
  }
}
