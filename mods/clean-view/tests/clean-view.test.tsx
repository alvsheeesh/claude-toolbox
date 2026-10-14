import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cleanName } from '../hooks/clean-view'

const PLUGIN = 'clean-view'
const PLAN = 'mcp__clean-view__plan_steps'
const REPORT = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const

const bandProps = (bodyColumns = 80) => ({
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
})

/** What the engine would answer beneath the plugin, so a test runs a session's worth of events. */
function engineBeneath(on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.toast', () => ({ value: undefined }))
  on('classic.Notification', () => ({}))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'Build my landing page',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  return clock
}

/** The band's text on the terminal, row by row, as the person reads it. */
async function bandText($: Engine, bodyColumns = 80) {
  const ui = await mountBand($, 'terminal', bodyColumns)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts.join('|')
}

async function startJob($: Engine, text = 'Please build my landing page') {
  await $.turn.start({ text, turnId: 'turn-1' })
}

async function mountBand($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 80) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(bodyColumns) })
}

describe('plain names', () => {
  test('backtick code, paths and long names are cleaned', () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
    expect(cleanName('update src/components/Footer.tsx with new links')).toBe('Update with new links')
    expect(cleanName('fix the bug in app.py quickly')).toBe('Fix the bug in quickly')
    const long = cleanName('Write a really long and detailed description of every single pricing tier we offer')
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).toEndWith('…')
    expect(cleanName('`npm run build`')).toBe('Working on it')
  })
})

test('a to-do list plus a 60% report draws done, current, next and up next rows', async ($, on) => {
  engineBeneath(on)
  await startJob($)
  await $.tool.call({
    tool: 'TodoWrite',
    tool_use_id: 'todo-1',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading your brand notes' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building the pricing section' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding the contact form' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing the footer' },
    ],
  } as never)
  await $.tool.call({ tool: REPORT, tool_use_id: 'rp-1', task: 'Build the pricing section', percent: 60 } as never)

  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    expect(await ui.find({ type: 'Text', text: /^✓ $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▶ $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /██████░░░░/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '60%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Next' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Up next' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'clean-view-toggle' })).toBeDefined()
    await ui.unmount()
  }
})

test('a permission prompt shows Needs you', async ($, on) => {
  engineBeneath(on)
  await startJob($)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude needs your OK to continue/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/simple off hides the band but keeps the button', async ($, on) => {
  engineBeneath(on)
  await startJob($)
  await $.tool.call({ tool: PLAN, tool_use_id: 'p-1', steps: ['Read your notes', 'Write the page'] } as never)
  const answer = await $.command.run({
    command: 'simple',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(answer.text).toBe('Clean View is off.')
  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    expect(await ui.find({ type: 'Text', text: /Read your notes/ })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'clean-view-toggle' }))?.props.label).toBe('○ Clean View: OFF')
    await ui.unmount()
  }
})

test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
  engineBeneath(on)
  await startJob($)
  const planned = await $.tool.call({
    tool: PLAN,
    tool_use_id: 'p-1',
    steps: ['Read your notes', 'Build the page', 'Check it works'],
  } as never)
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')
  const reported = await $.tool.call({ tool: REPORT, tool_use_id: 'r-1', task: 'Read your notes', percent: 100 } as never)
  expect(reported.result).toBe('Progress noted: 100%.')
  const ui = await mountBand($, 'terminal')
  const rows = await ui.findAll({ type: 'Text', text: /^(✓|▶|○) $/ })
  expect(rows.map(r => r.text.trim())).toEqual(['✓', '▶', '○'])
  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Next' })).toBeDefined()
  await ui.unmount()
  const clamped = await $.tool.call({ tool: REPORT, tool_use_id: 'r-2', task: 'Build the page', percent: 250 } as never)
  expect(clamped.result).toBe('Progress noted: 100%.')
})

test('tools are denied before a plan exists and allowed after', async ($, on) => {
  engineBeneath(on)
  await startJob($)
  const before = await $.tool.call({ tool: 'Bash', tool_use_id: 'b-1', command: 'ls' } as never)
  expect(before.deny).toContain('plan_steps')
  const search = await $.tool.call({ tool: 'ToolSearch', tool_use_id: 's-1', query: 'select:plan_steps' } as never)
  expect(search.deny).toBeUndefined()
  await $.tool.call({ tool: PLAN, tool_use_id: 'p-1', steps: ['Look around', 'Answer you'] } as never)
  const after = await $.tool.call({ tool: 'Bash', tool_use_id: 'b-2', command: 'ls' } as never)
  expect(after.deny).toBeUndefined()
  expect(after.result).toBe('ok')
})

test('subagents are never gated', async ($, on) => {
  engineBeneath(on)
  await startJob($)
  const call = await $.tool.call({ tool: 'Bash', tool_use_id: 'b-1', command: 'ls', agentId: 'agent-1' } as never)
  expect(call.deny).toBeUndefined()
})

test('a finished job says All done and collapses after 5 seconds', async ($, on) => {
  const clock = engineBeneath(on)
  await startJob($)
  await $.tool.call({ tool: PLAN, tool_use_id: 'p-1', steps: ['Answer your question'] } as never)
  await $.tool.call({ tool: REPORT, tool_use_id: 'r-1', task: 'Answer your question', percent: 100 } as never)
  await $.turn.complete({ answer: 'Here you go', durationMs: 1000, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect(await bandText($)).toContain('Done')
  expect(await bandText($)).toContain('✓ All done')
  await clock.advance(5000)
  const collapsed = await bandText($)
  expect(collapsed).toContain('✓ All done')
  expect(collapsed).not.toContain('Done|')
  expect(collapsed).not.toContain('Answer your question')
})

test('Esc shows Stopped, an API error shows one calm sentence', async ($, on) => {
  engineBeneath(on)
  await startJob($)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 'turn-1', reason: 'aborted' })
  expect(await bandText($)).toContain('■ Stopped')
  expect(await bandText($)).toContain('you pressed Esc')
  await $.turn.start({ text: 'Try again please', turnId: 'turn-2' })
  await $.turn.complete({
    answer: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    durationMs: 1000,
    isAborted: false,
    turnId: 'turn-2',
    reason: 'error',
  })
  const band = await bandText($)
  expect(band).toContain('⚠ Stuck:')
  expect(band).toContain("Claude's servers are busy, try again in a minute")
})

test('rows never wrap on a narrow terminal', async ($, on) => {
  engineBeneath(on)
  await startJob($)
  await $.tool.call({ tool: PLAN, tool_use_id: 'p-1', steps: ['Read every one of your brand notes'] } as never)
  const ui = await mountBand($, 'terminal', 40)
  const name = await ui.find({ type: 'Text', text: /^Read/ })
  expect(name?.text.length).toBeLessThanOrEqual(40 - 23)
})

test('tool rows are hidden while Clean View is on and come back when it is off', async ($, on) => {
  engineBeneath(on)
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Bash(ls)</Text>
  })
  const row = {
    plugin: PLUGIN,
    component: 'ToolUse',
    props: { tool_use_id: 'u-1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
  } as const
  for (const surface of SURFACES) {
    const hidden = await $.ui.mount({ ...row, surface })
    const drawn = await hidden.drawn()
    expect('props' in drawn ? drawn.props : undefined).toMatchObject({ display: 'none' })
    await hidden.unmount()
  }
  await $.command.run({ command: 'simple', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const shown = await $.ui.mount({ ...row, surface: 'terminal' })
  expect(await shown.find({ type: 'Text', text: 'Bash(ls)' })).toBeDefined()
})
