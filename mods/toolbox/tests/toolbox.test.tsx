import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { autoReason, displayName, modName, readMods, spendSummary, meterCells, meterWidth, limitsFor, flame, money, stepRow, stepsHeader, stepsLine, GOLD, RED } from '../hooks/logic'

const PLUGIN = 'toolbox'
const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** Settings as `claude plugin list --json` would print them; enable/disable flip them. */
function engineBeneath(on: On, answeredBy = 'claude-opus-5-5', stored: Record<string, unknown> | null = {}) {
  // A test that reads what was stored passes null and answers the store itself.
  if (stored !== null) mock.store(on, stored)
  const enabled: Record<string, boolean> = {
    'clean-view@claude-toolbox': true,
    'auto-model@claude-toolbox': true,
    'toolbox@claude-toolbox': true,
    'figma@synced': true,
  }
  const ran: string[][] = []
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    const [, , verb, id] = e.argv
    if (verb === 'enable' || verb === 'disable') enabled[id] = verb === 'enable'
    const stdout = verb === 'list' ? JSON.stringify(Object.entries(enabled).map(([id, on]) => ({ id, enabled: on }))) : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }) as never)
  // Beneath the plugin, the band is empty (no other mod draws in it) and the engine's hint line
  // under the prompt reads as the engine draws it.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: answeredBy } } as never
  })
  return { enabled, ran }
}

async function step($: Engine, effort = 'high') {
  await $.turn.start({ text: 'hi', turnId: 'turn-1' } as never)
  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 } as never)) {
    // drain
  }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

/** The dock where it sits by default: under the prompt, in the hint line's site. */
async function mountBox($: Engine) {
  return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'PromptHint', props: HINT } as never)
}

async function mountBand($: Engine) {
  return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND } as never)
}

async function textsOf(ui: Awaited<ReturnType<typeof mountBox>>) {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts.join('|')
}

async function boxText($: Engine) {
  return textsOf(await mountBox($))
}

describe('plain words', () => {
  test('names read as people say them', () => {
    expect(modName('clean-view@claude-toolbox')).toBe('Clean View')
    expect(displayName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(autoReason('heavy', 'classified')).toBe('heavy task')
    expect(autoReason('light', 'short-reply')).toContain('short reply')
  })

  test('a step reads Done, its percent, Paused or Next', () => {
    const step = { id: 'a', name: 'Step', percent: 40, hasReported: true }
    expect(stepRow({ ...step, status: 'done' }, false).label).toBe('Done')
    expect(stepRow({ ...step, status: 'active' }, false).label).toBe('40%')
    expect(stepRow({ ...step, status: 'active', hasReported: false }, false).label).toBe('Working')
    expect(stepRow({ ...step, status: 'active' }, true).label).toBe('Paused')
    expect(stepRow({ ...step, status: 'upcoming' }, false).label).toBe('Next')
  })

  test('the steps header says why the job waits', () => {
    const steps = { title: 'Move the panels', phase: 'working', tasks: [], needsYouReason: null, stuckReason: null, isCollapsed: false } as const
    expect(stepsHeader(steps)).toBe('Move the panels')
    expect(stepsHeader({ ...steps, phase: 'needs-you', needsYouReason: 'Claude has a question for you' })).toBe('Needs you: Claude has a question for you')
    expect(stepsHeader({ ...steps, phase: 'done' })).toBe('All done: Move the panels')
  })

  test('the steps fit on one line: a mark each, then the step under way', () => {
    const tasks = [
      { id: 'a', name: 'Learn how it works', status: 'done', percent: 100, hasReported: true },
      { id: 'b', name: 'Move the panels', status: 'active', percent: 40, hasReported: true },
      { id: 'c', name: 'Test the layout', status: 'upcoming', percent: 0, hasReported: false },
    ] as const
    const steps = { title: 'Job', phase: 'working', tasks: [...tasks], needsYouReason: null, stuckReason: null, isCollapsed: false } as const
    expect(stepsLine(steps)).toEqual({ marks: '✓▶○', title: 'Move the panels', detail: '40% · 1/3', color: 'cyan', isAlert: false })
    expect(stepsLine({ ...steps, phase: 'needs-you', needsYouReason: 'Claude has a question for you' })).toEqual({
      marks: '✓‖○',
      title: 'Needs you: Claude has a question for you',
      detail: '1/3',
      color: 'yellow',
      isAlert: true,
    })
    expect(stepsLine({ ...steps, phase: 'done', isCollapsed: true })).toBeNull()
  })

  test('the spend reads like Burn Meter: money, the plan windows, a fill', () => {
    const burn = { shown: 2.48, target: 2.5, isDemo: false, session: 30, week: 12 }
    expect(spendSummary(burn)).toEqual({ money: '$2.48', isRolling: true, fill: 0.3, color: GOLD, limits: '5h 30% · wk 12%' })
    expect(spendSummary({ ...burn, shown: 0, target: 0, session: -1, week: -1 })).toBeNull()
    expect(spendSummary({ ...burn, session: -1, week: -1 })?.limits).toBe('')
    expect(spendSummary({ ...burn, session: 90 })?.color).toBe(RED)
    expect(money(0.0042)).toBe('$0.0042')
  })

  test('the meter lights gold to red and gives way on a narrow terminal', () => {
    expect(meterCells(10, 0.3)).toEqual({ lit: [flame(0), flame(1 / 9), flame(2 / 9)], unlit: 7 })
    expect(meterCells(10, 0).lit).toEqual([])
    expect(meterCells(10, 0.01).lit.length).toBe(1)
    expect(flame(0)).toBe(GOLD)
    expect(flame(1)).toBe(RED)
    expect(meterWidth(120)).toBe(14)
    expect(meterWidth(60)).toBe(0)
    expect(limitsFor('5h 30% · wk 12%', 80)).toBe('5h 30% · wk 12%')
    expect(limitsFor('5h 30% · wk 12%', 50)).toBe('5h 30%')
  })

  test('only the toolbox mods are listed, never the panel itself', () => {
    const json = JSON.stringify([
      { id: 'toolbox@claude-toolbox', enabled: true },
      { id: 'figma@synced', enabled: true },
      { id: 'clean-view@claude-toolbox', enabled: false },
    ])
    expect(readMods(json, new Map()).map(m => m.name)).toEqual(['Clean View'])
  })
})

test('the panel shows the model that answered and its effort', async ($, on) => {
  engineBeneath(on, 'claude-sonnet-5-5')
  await $.session.start({ cwd: '/tmp' } as never)
  expect(await boxText($)).toContain('no reply yet')
  await step($, 'medium')
  const text = await boxText($)
  expect(text).toContain('Sonnet 5.5')
  expect(text).toContain('medium')
  expect(text).not.toContain('(auto)')
})

test('the panel still draws when Clean View is not loaded', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: '/tmp' } as never)
  await $.command.run({ command: 'toolbox', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const ui = await mountBox($)
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('no reply yet')
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['mods ▾'])
  await ui.unmount()
})

test('the switches stay folded under `mods` and no button answers a digit', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: '/tmp' } as never)
  await $.command.run({ command: 'toolbox', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  const ui = await mountBox($)
  await ui.press({ key: 'toolbox-mods' })
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(b => b.text)).toEqual(['mods ▴', '● Auto Model', '● Clean View'])
  // A bare digit typed into an empty prompt presses a band Button with that hotkey.
  expect(buttons.map(b => b.props.hotkey)).toEqual([undefined, undefined, undefined])
  await ui.press({ key: 'toolbox-mods' })
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['mods ▾'])
  await ui.unmount()
})

test('the box shows with the session and hands the steps back when hidden', async ($, on) => {
  engineBeneath(on)
  const hosting: unknown[] = []
  on('state.set', { plugin: 'toolbox', key: 'hosting' } as never, ($, e, next) => {
    hosting.push((e as { value?: unknown }).value)
    return next(e)
  })
  await $.session.start({ cwd: '/tmp' } as never)
  expect(hosting.at(-1)).toBe(true)
  const hidden = await $.command.run({ command: 'toolbox', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(hidden.text).toBe('Toolbox hidden. /toolbox shows it again.')
  expect(hosting.at(-1)).toBe(false)
  expect(await boxText($)).not.toContain('no reply yet')
})

test('the dock sits under the prompt, below the hint line, and leaves the band empty', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: '/tmp' } as never)
  const under = await boxText($)
  expect(under).toContain('no reply yet')
  expect(under.indexOf('? for shortcuts')).toBeLessThan(under.indexOf('no reply yet'))
  expect(await textsOf(await mountBand($))).not.toContain('no reply yet')
})

test('/toolbox top moves the dock above the prompt and /toolbox bottom brings it back, kept for next time', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined } as never
  })
  engineBeneath(on, 'claude-opus-5-5', null)
  await $.session.start({ cwd: '/tmp' } as never)
  const run = (args: string) =>
    $.command.run({ command: 'toolbox', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
  expect((await run('top')).text).toBe('Toolbox shown above the prompt.')
  expect(await textsOf(await mountBand($))).toContain('no reply yet')
  expect(await boxText($)).toBe('? for shortcuts')
  expect(store.get('placement')).toBe('top')
  expect((await run('bottom')).text).toBe('Toolbox shown under the prompt.')
  expect(await boxText($)).toContain('no reply yet')
  expect(store.get('placement')).toBe('bottom')
})

test('a session starts with the dock where it was left', async ($, on) => {
  engineBeneath(on, 'claude-opus-5-5', { placement: 'top' })
  await $.session.start({ cwd: '/tmp' } as never)
  expect(await textsOf(await mountBand($))).toContain('no reply yet')
  expect(await boxText($)).toBe('? for shortcuts')
})

test('/toolbox mods opens and folds the switches from the keyboard', async ($, on) => {
  engineBeneath(on)
  await $.session.start({ cwd: '/tmp' } as never)
  const run = (args: string) =>
    $.command.run({ command: 'toolbox', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
  expect((await run('mods')).text).toBe('Toolbox switches open. /toolbox mods folds them.')
  const ui = await mountBox($)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.text)).toEqual(['mods ▴', '● Auto Model', '● Clean View'])
  await ui.unmount()
  expect((await run('mods')).text).toBe('Toolbox switches folded.')
})

test('a switch disables a mod in user settings and asks for a reload', async ($, on) => {
  const { enabled, ran } = engineBeneath(on)
  await $.session.start({ cwd: '/tmp' } as never)
  const opened = await $.command.run({ command: 'toolbox', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  expect(opened.text).toBe('Toolbox shown under the prompt.')
  const ui = await mountBox($)
  await ui.press({ key: 'toolbox-mods' })
  await ui.press({ key: 'clean-view@claude-toolbox' })
  expect(ran).toContainEqual(['claude', 'plugin', 'disable', 'clean-view@claude-toolbox', '--scope', 'user'])
  expect(enabled['clean-view@claude-toolbox']).toBe(false)
  await ui.unmount()
  const text = await boxText($)
  expect(text).toContain('* after /reload-plugins')
  expect(text).toContain('mods* ▴')
})
