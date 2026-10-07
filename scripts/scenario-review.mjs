// Writes docs/SCENARIO_REVIEW.md: a plain-English sheet of the HELP scenario drafts for Keith.
// Keith reviews it and says which ones match his judgment; only then is golden_approved flipped.
// Usage: node scripts/scenario-review.mjs
import fs from 'node:fs'
import path from 'node:path'

const dir = 'evals/scenarios/help'
const playbook = JSON.parse(fs.readFileSync('config/playbook.json', 'utf8'))
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const who = (sc, id) => {
  if (id === 'keith') return 'Keith'
  const sp = sc.speakers?.[id]
  if (!sp) return 'Unknown speaker'
  const role = { buyer: 'Buyer', teammate: 'Teammate', sa: 'SA', unknown: 'Unknown' }[sp.role] ?? sp.role
  return sp.name ? `${sp.name.split(' (')[0]} (${role})` : role
}
const move = (m) => `${m.replace(/_/g, ' ')}${playbook.moves[m] ? `: ${playbook.moves[m]}` : ''}`

const out = [
  '# HELP practice moments: review sheet',
  '',
  `${files.length} made-up call moments (no real companies or calls). Each one stops where Keith presses HELP.`,
  'For each: is the "Good HELP" right, and is the "Bad HELP" list right? Reply with the numbers you agree with,',
  'and a one-line fix for any you don\'t. Only the ones you approve become the Golden Set that decides which model wins.',
  '',
  `Generated from \`${dir}\` by \`node scripts/scenario-review.mjs\`. Do not edit by hand.`,
  '',
]

files.forEach((f, i) => {
  const sc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  const gaps = (sc.gaps ?? []).filter((g) => g.start < sc.help_at_s).map((g) => ({ t: g.start, gap: g }))
  const before = [...sc.transcript.filter((l) => l.t < sc.help_at_s), ...gaps].sort((a, b) => a.t - b.t).slice(-6)
  out.push(`## ${i + 1}. ${sc.id}${sc.golden_approved ? ' ✅ approved' : ''}`)
  out.push('')
  out.push(`**Call:** ${sc.call_type}${sc.call_goal ? `. Goal: ${sc.call_goal}` : ''}${sc.deployment ? `. Buyer's deployment: ${sc.deployment.replace('_', '-')}` : ''}`)
  // M5 call modes: the call's length when the moment depends on the time left, and a step-2 moment.
  if (sc.length_min) out.push(`**When:** minute ${Math.floor(sc.help_at_s / 60)} of a ${sc.length_min}-minute call`)
  if (sc.tags?.includes('step_2')) out.push('**Step 2:** judged only once the SA-aware demo cards are on, after the real two-person demo call.')
  if ((sc.knowledge ?? []).length) {
    out.push(`**Docs HELP has:** ${sc.knowledge.map((k) => `${k.title}${k.approved === false ? ' (not approved)' : ''}${k.applies_to?.length ? ` (applies to: ${k.applies_to.join(', ')})` : ''}${k.review_by ? ` (review by ${k.review_by})` : ''}`).join('; ')}`)
  } else {
    out.push('**Docs HELP has:** none')
  }
  // M4: Keith's own notes on the account ("What I know"), as HELP gets them.
  if (sc.account_notes) out.push(`**Keith's notes (What I know):** ${sc.account_notes.split('\n').join(' / ')}`)
  // What earlier calls with the account left behind, as HELP gets them.
  if (sc.earlier_calls?.length) out.push(`**From earlier calls:** ${sc.earlier_calls.map((e) => `${e.date}: ${e.text}`).join(' / ')}`)
  out.push('')
  out.push(`**Last lines before ${sc.wrap === 'button' ? 'WRAP' : 'HELP'}** (press at ${mmss(sc.help_at_s)}):`)
  // Earlier lines aren't shown; say how many, and how many were Keith's questions (M5 counts them).
  const hidden = sc.transcript.filter((l) => l.t < sc.help_at_s && !before.includes(l))
  const asked = hidden.filter((l) => l.who === 'keith' && l.text.includes('?')).length
  if (hidden.length) out.push(`> *(${hidden.length} earlier line${hidden.length === 1 ? '' : 's'} not shown${asked ? `, ${asked} of them Keith's questions` : ''})*`)
  for (const l of before) {
    // A line still being spoken at the press: HELP only sees its first words, as live text.
    const live = !l.gap && (l.end ?? l.t) > sc.help_at_s - 1 ? ' *(still talking when Keith presses: HELP sees only the start)*' : ''
    out.push(l.gap ? `> *[${Math.round(l.gap.end - l.gap.start)} s of meeting audio not heard]*` : `> **${who(sc, l.who)}:** ${l.text}${live}`)
  }
  out.push('')
  out.push('**Good HELP would:**')
  for (const m of sc.best_moves) out.push(`- ${move(m)}`)
  if (sc.acceptable_moves?.length) out.push(`- Also fine: ${sc.acceptable_moves.map((m) => m.replace(/_/g, ' ')).join(', ')}`)
  if (sc.acceptable_questions?.length) {
    out.push('')
    out.push('Example good lines:')
    for (const q of sc.acceptable_questions) out.push(`- "${q}"`)
  }
  if (sc.unacceptable_behaviors?.length) {
    out.push('')
    out.push('**Bad HELP would:**')
    for (const b of sc.unacceptable_behaviors) out.push(`- ${b}`)
  }
  out.push('')
  out.push('Approve? ☐ Yes ☐ No. Fix: ______')
  out.push('')
})

fs.writeFileSync('docs/SCENARIO_REVIEW.md', out.join('\n'))
console.log(`wrote docs/SCENARIO_REVIEW.md (${files.length} scenarios)`)
