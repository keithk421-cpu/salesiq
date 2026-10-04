# Evaluation Strategy
Runner: Promptfoo. Verify pinned version/license at implementation.

## Level 1: Correctness — hard gate
Block on critical failures: invented facts/pain; proposed->agreed; asked->answered without evidence; automatic Coach on disallowed role; cross-deal leakage; expired/unauthorized claims; manual correction overwritten; stale card rendered.

## Level 2: Quality — threshold
Grade relevance, neutrality, concision, correct move, discovery progression, non-repetition, useful Missing label, timing, and appropriate NO_MOVE.

## Level 3: Keith Golden Set — hard sales-quality gate
Agent drafts only. Every candidate starts `golden_approved: false`. Only Keith approves.

Each stores: call type/goal; transcript only through decision point; warm state; best move(s); acceptable alternatives; unacceptable behaviors; silence preferred; optional acceptable questions; Keith notes.

Do not require exact wording. Grade move, premise, usefulness and prohibited behavior.

## First 50 drafts
8 neutral discovery/no assumed pain; 6 partial-vs-answered; 6 next-step states; 6 objections; 6 competitors; 5 technical clarify-vs-answer; 5 teammate inquiry->buyer answer; 8 Should've-stayed-quiet.

Silence cases must include subtle examples: full answer with next rung already established; SA productively owns thread; complex technical answer fully answers SA; buyer is still thinking; neutral competitor mention; issue already answered earlier; next step already agreed; buyer corrects premise and state should update rather than pitch.

## Live feedback
Footer is always `Useful | Should've stayed quiet | Bad`.
Should've-stayed-quiet primarily tunes Coach firing precision. Bad reasons optionally: wrong move, assumed too much, already known, too generic, too late, bad wording, unsupported, other.

Convert high-value failures to candidate scenarios; never Golden until Keith approves.

## CI
Unit/domain -> audio/turn fixtures -> Level 1 -> Level 2 -> Level 3 -> regression diff vs accepted baseline. Level 1 and Level 3 are hard gates.
