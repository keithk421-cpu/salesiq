/**
 * What the price check (protocol.ts priceFigures) needs from the call, as at the press (M5 step 0):
 * the context's sources (an approved item's text backs a figure the card cites), the other side's
 * words (Keith may ask their own figure back), and the call type then (pricing calls check harder).
 * Everything comes from the request's own context and the call's turns, so the live card, the
 * streaming check and the speed test all judge a line the same way. Nothing here is logged or stored.
 */
import type { AccountMemoryKind } from '../../shared/help'
import type { CallMemory } from './callMemory'
import type { BuiltContext } from './context'
import type { PriceCheckOpts } from './protocol'

/**
 * Earlier-call items that are their words. Arize's promises, Keith's own plan, open items (a
 * "proposed" item may be Arize's own number) and agreed steps (either side) are not.
 */
const THEIR_EARLIER_KINDS = new Set<AccountMemoryKind>(['they_owe', 'wants', 'fact'])

export function priceCheckInputs(memory: CallMemory, ctx: BuiltContext): PriceCheckOpts {
  const atMs = ctx.refs.at_session_ms
  // Their side, all call long: a buyer's budget from ten minutes ago is still theirs to ask about.
  // Meeting audio only, except a tagged Arize teammate (the SA's figures are not theirs to ask back).
  const turns = memory.turnsAsOf(atMs).filter((t) => memory.fromTheirSide(t)).map((t) => t.text)
  // Their live words at the press: the model saw them as provisional text, so asking that figure back
  // is still asking theirs. A tagged teammate's live words (by the newest word's speaker id) are left
  // out, the same as their finished turns; a line with no speaker id yet counts as theirs.
  const live = memory.interimsAsOf(atMs).filter((i) => memory.fromTheirSide({ stream: i.stream, cluster: i.cluster ?? null })).map((i) => i.text)
  // What they said on earlier calls, exactly as the request showed it.
  const earlier = (ctx.refs.earlier_calls ?? []).filter((e) => THEIR_EARLIER_KINDS.has(e.kind)).map((e) => e.text)
  return {
    sources: ctx.sources,
    theirText: [...turns, ...live, ...earlier].join('\n'),
    // The type the request was built with (Keith can change it mid-call); older contexts don't carry it.
    callType: ctx.refs.call_setup?.call_type ?? memory.setup.call_type,
  }
}
