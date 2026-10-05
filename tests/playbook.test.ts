import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { playbookProblem, type Playbook } from '../src/main/help/prompt'
import { CALL_TYPES, SALES_MOVES } from '../src/shared/help'

const built = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../config/playbook.json', import.meta.url)), 'utf8')) as Playbook

/** The built-in playbook with its moves (or call types) rebuilt by `edit`. */
function edited(k: 'moves' | 'call_types', edit: (entries: Array<[string, string]>) => Array<[string, string]>): Playbook {
  return { ...built, [k]: Object.fromEntries(edit(Object.entries(built[k]))) }
}

describe('playbook check', () => {
  it('accepts the built-in playbook, which names every move and call type HELP knows', () => {
    expect(playbookProblem(built)).toBeNull()
    expect(Object.keys(built.moves).sort()).toEqual([...SALES_MOVES].sort())
    expect(Object.keys(built.call_types).sort()).toEqual([...CALL_TYPES].sort())
  })

  it('rejects a renamed move, naming it and the names HELP accepts', () => {
    const pb = edited('moves', (e) => e.map(([k, v]) => [k === 'clarify_current_state' ? 'clarify_state' : k, v]))
    const problem = playbookProblem(pb)
    expect(problem).toMatch(/^"moves" has "clarify_state", which isn't a name HELP knows/)
    for (const m of SALES_MOVES) expect(problem).toContain(m)
  })

  it('rejects a playbook without no_move', () => {
    const pb = edited('moves', (e) => e.filter(([k]) => k !== 'no_move'))
    expect(playbookProblem(pb)).toBe('"moves" must keep "no_move" (HELP uses it when there is nothing useful to add)')
  })

  it('allows dropping a move Keith does not want, and editing descriptions', () => {
    expect(playbookProblem(edited('moves', (e) => e.filter(([k]) => k !== 'handle_competitor')))).toBeNull()
    expect(playbookProblem(edited('moves', (e) => e.map(([k, v]) => [k, `${v} Keep it short.`])))).toBeNull()
  })

  it('rejects call types HELP does not know', () => {
    const pb = edited('call_types', (e) => e.map(([k, v]) => [k === 'technical_deep_dive' ? 'deep_dive' : k, v]))
    expect(playbookProblem(pb)).toMatch(/^"call_types" has "deep_dive", which isn't a name HELP knows\. Keep the call type names as they were/)
    const two = edited('moves', (e) => [...e, ['pitch', 'x'], ['close', 'y']])
    expect(playbookProblem(two)).toMatch(/^"moves" has "pitch", "close", which aren't names HELP knows/)
  })
})
