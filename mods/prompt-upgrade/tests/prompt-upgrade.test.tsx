import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bigNumber, readQuestions, readRewrite, route } from '../hooks/logic'

const PLUGIN = 'prompt-upgrade'
const PANE = 'prompt-upgrade'
const SURFACES = ['terminal', 'desktop'] as const
const ROUGH = 'write a landing page for my bakery'
const UPGRADED = 'Write a one-page landing page for my bakery, [bakery name], aimed at local families.'

const QUESTIONS_REPLY = JSON.stringify({
  questions: [
    { question: 'Who is it for?', options: ['Local families', 'Office workers'] },
    { question: 'What format?', options: ['HTML page', 'Copy only', 'Wireframe'] },
  ],
})
const REWRITE_REPLY = `Here you go: ${JSON.stringify({ prompt: UPGRADED, added: ['Audience', 'Placeholder for the name'] })}`

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type Beneath = { submits: string[]; fills: string[]; rewriteAsks: string[] }

/** What the engine would answer beneath the plugin. */
function engineBeneath(on: On, opts: { questions?: string } = {}): Beneath {
  const seen: Beneath = { submits: [], fills: [], rewriteAsks: [] }
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', (_$, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    seen.submits.push(e.text)
    return { text: e.text }
  })
  on('model.complete', (_$, e) => {
    const isRewrite = String(e.system ?? '').includes('rewrite')
    if (isRewrite) seen.rewriteAsks.push(String(e.prompt))
    return { value: { isAnswered: true, text: isRewrite ? REWRITE_REPLY : (opts.questions ?? QUESTIONS_REPLY), usage } }
  })
  return seen
}

const composer = { kind: 'composer' } as const

function typed($: Engine, text: string, extra: Record<string, unknown> = {}) {
  return $.prompt.submit({ text, wait: false, origin: composer, ...extra } as never)
}

function better($: Engine, args: string) {
  return $.command.run({ command: 'better', args, origin: composer, presentation: { isFullscreen: false, columns: 120 } })
}

/** The step the pane shows: its root box is keyed by it. */
async function flowStep($: Engine) {
  const ui = await mountPane($, 'terminal')
  const steps = ['none', 'compose', 'reading', 'questions', 'rewriting', 'review', 'error', 'history']
  let found: string | undefined
  for (const step of steps) {
    if ((await ui.find({ key: `step-${step}` })) !== undefined) found = step
  }
  await ui.unmount()
  return found
}

/** Lets background work (the model calls) settle. */
async function until($: Engine, step: string) {
  for (let i = 0; i < 200 && (await flowStep($)) !== step; i++) await Promise.resolve()
  expect(await flowStep($)).toBe(step)
}

const paneProps = (bodyColumns: number) => ({
  title: 'Prompt Upgrade',
  isFocused: true,
  bodyColumns,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

function mountPane($: Engine, surface: (typeof SURFACES)[number], cols = 100) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: paneProps(cols) as never })
}

describe('which prompts are intercepted', () => {
  const base = { text: ROUGH, isAuto: true, hasCommand: false, isMeta: false, hasAttachments: false, isBusy: false, origin: 'composer' }

  test('a rough prompt typed with automatic mode on is held for the upgrade', () => {
    expect(route(base).kind).toBe('upgrade')
  })

  test('everything else passes untouched', () => {
    expect(route({ ...base, isAuto: false }).kind).toBe('pass')
    expect(route({ ...base, text: '/compact' }).kind).toBe('pass')
    expect(route({ ...base, hasCommand: true }).kind).toBe('pass')
    expect(route({ ...base, hasAttachments: true }).kind).toBe('pass')
    expect(route({ ...base, isBusy: true }).kind).toBe('pass')
    expect(route({ ...base, isMeta: true }).kind).toBe('pass')
    expect(route({ ...base, text: 'yes' }).kind).toBe('pass')
    expect(route({ ...base, text: 'keep going' }).kind).toBe('pass')
    expect(route({ ...base, text: 'vale, sigue' }).kind).toBe('pass')
    expect(route({ ...base, origin: 'plugin' }).kind).toBe('pass')
  })

  test('a leading > is stripped and the prompt goes straight through', () => {
    expect(route({ ...base, text: '> just do it as written' })).toEqual({ kind: 'strip', text: 'just do it as written' })
  })
})

describe('reading model replies', () => {
  test('questions: at most three, each with two to four options', () => {
    const reply = JSON.stringify({
      questions: [
        { question: 'A?', options: ['1', '2', '3', '4', '5'] },
        { question: 'B?', options: ['only one'] },
        { question: 'C?', options: ['x', 'y'] },
        { question: 'D?', options: ['x', 'y'] },
        { question: 'E?', options: ['x', 'y'] },
      ],
    })
    const qs = readQuestions(`Sure! ${reply}`)
    expect(qs?.length).toBe(3)
    expect(qs?.[0]?.options.length).toBe(4)
    expect(qs?.map(q => q.question)).toEqual(['A?', 'C?', 'D?'])
    expect(readQuestions('{"questions":[]}')).toEqual([])
    expect(readQuestions('no json here')).toBeUndefined()
  })

  test('rewrite: the prompt and what it added', () => {
    expect(readRewrite(REWRITE_REPLY)).toEqual({ upgraded: UPGRADED, added: ['Audience', 'Placeholder for the name'] })
    expect(readRewrite('{"prompt":"  ","added":[]}')).toBeUndefined()
    expect(readRewrite('oops')).toBeUndefined()
  })

  test('big numbers are three rows tall', () => {
    const rows = bigNumber(42)
    expect(rows.length).toBe(3)
    expect(rows[0]).toBe('╻ ╻ ╺━┓')
  })
})

test('/better on and off flip automatic mode', async ($, on) => {
  const seen = engineBeneath(on)
  expect((await better($, 'on')).text).toMatch(/is on/)
  expect((await typed($, ROUGH)).drop).toBe('Sent to Prompt Upgrade.')
  expect(seen.submits).toEqual([])

  expect((await better($, 'off')).text).toMatch(/is off/)
  await typed($, 'another rough prompt about cakes')
  expect(seen.submits).toEqual(['another rough prompt about cakes'])
})

test('with automatic mode on, short replies, > prompts and busy prompts pass', async ($, on) => {
  const seen = engineBeneath(on)
  await better($, 'on')
  await typed($, 'yes')
  await typed($, '> send this exactly please')
  await typed($, 'a long prompt typed while Claude works', { turnId: 'turn-1' })
  expect(seen.submits).toEqual(['yes', 'send this exactly please', 'a long prompt typed while Claude works'])
})

test('the full flow: /better, questions, rewrite, review, Run', async ($, on) => {
  const seen = engineBeneath(on)
  await better($, 'on') // the mod's own send must not loop back into the pane
  const answer = await better($, ROUGH)
  expect(answer.text).toBe('Upgrading your prompt.')
  await until($, 'questions')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'Who is it for?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0 of 2 answered/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'q0o0' })
  expect(await ui.find({ type: 'Text', text: /1 of 2 answered/ })).toBeDefined()
  await ui.press({ key: 'q1skip' })
  await ui.unmount()
  await until($, 'review')
  expect(seen.rewriteAsks[0]).toContain('Who is it for? → Local families')
  expect(seen.rewriteAsks[0]).not.toContain('What format?')

  for (const surface of SURFACES) {
    const review = await mountPane($, surface)
    expect(await review.find({ type: 'Text', text: UPGRADED })).toBeDefined()
    expect(await review.find({ type: 'Text', text: 'Audience' })).toBeDefined()
    expect(await review.find({ type: 'Button', key: 'run' })).toBeDefined()
    await review.unmount()
  }

  const review = await mountPane($, 'terminal')
  await review.press({ key: 'run' })
  await review.unmount()
  expect(seen.submits).toEqual([UPGRADED])
  expect(await flowStep($)).toBe('none')
})

test('no helpful question goes straight to the rewrite', async ($, on) => {
  engineBeneath(on, { questions: '{"questions":[]}' })
  await better($, ROUGH)
  await until($, 'review')
})

test('Cancel puts the original prompt back in the box', async ($, on) => {
  const seen = engineBeneath(on)
  await better($, ROUGH)
  await until($, 'questions')
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'cancel' })
  await ui.unmount()
  expect(seen.fills).toEqual([ROUGH])
  expect(seen.submits).toEqual([])
  expect(await flowStep($)).toBe('none')
})

test('rows fit the pane at a narrow and a wide width', async ($, on) => {
  engineBeneath(on)
  await better($, ROUGH)
  await until($, 'questions')
  for (const cols of [40, 140]) {
    const ui = await mountPane($, 'terminal', cols)
    const rules = await ui.findAll({ type: 'Text', text: /^[━─]+$/ })
    expect(rules.length).toBeGreaterThan(0)
    let total = 0
    for (const r of rules) total += r.text.length
    // The title rule (gold + hairline) spans the pane exactly; headings stay inside it.
    expect(total).toBeGreaterThanOrEqual(cols)
    for (const r of rules) expect(r.text.length).toBeLessThanOrEqual(cols)
    await ui.unmount()
  }
})
