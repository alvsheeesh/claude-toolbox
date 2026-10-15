import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DOWNGRADE_MAX_MESSAGES, TIERS, decide, label, readTier } from '../hooks/logic'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type Seen = { models: string[]; efforts: unknown[]; classified: number }

/** The engine beneath: a classifier that answers by keyword, and a model step that records what it was asked. */
function engineBeneath(on: On): Seen {
  const seen: Seen = { models: [], efforts: [], classified: 0 }
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('model.complete', (_$, e) => {
    seen.classified += 1
    const text = String(e.prompt)
    const tier = /architecture|refactor/.test(text) ? 'heavy' : /what time|rename/.test(text) ? 'light' : 'standard'
    return { value: { isAnswered: true, text: tier, usage } }
  })
  on('turn.step', async function* (_$, e) {
    seen.models.push(e.model)
    seen.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  return seen
}

let turn = 0
async function runTurn($: Engine, text: string, opts: { messageCount?: number; steps?: number; agentId?: string; model?: string } = {}) {
  turn += 1
  const turnId = `turn-${turn}`
  await $.turn.start({ text, turnId, ...(opts.agentId ? { agentId: opts.agentId } : {}) } as never)
  for (let index = 0; index < (opts.steps ?? 1); index++) {
    const stream = $.turn.step({
      turnId,
      index,
      model: opts.model ?? 'claude-opus-5-5',
      effort: 'high',
      messageCount: opts.messageCount ?? 1,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    } as never)
    for await (const _chunk of stream) {
      // drain
    }
  }
}

describe('picking a tier', () => {
  test('the classifier word is read', () => {
    expect(readTier('Heavy.')).toBe('heavy')
    expect(readTier('light')).toBe('light')
    expect(readTier('no idea')).toBeUndefined()
  })

  test('heavier work always moves up; lighter work moves down only early on', () => {
    const heavy = decide('heavy', null, 1)
    expect(heavy.model).toBe('claude-opus-5-5')
    expect(decide('light', heavy, 3).model).toBe('claude-sonnet-5-5')
    expect(decide('light', heavy, DOWNGRADE_MAX_MESSAGES + 1).model).toBe('claude-opus-5-5')
    expect(decide('heavy', decide('light', null, 1), 99).model).toBe('claude-opus-5-5')
    expect(decide(undefined, null, 1).model).toBe('claude-sonnet-5-5')
  })

  test('every tier names a full model id, never an alias the API would 404', () => {
    for (const { model } of Object.values(TIERS)) expect(model).toMatch(/^claude-[a-z]+-\d+-\d+$/)
  })

  test('the status label reads as a model name', () => {
    expect(label(decide('light', null, 1))).toBe('auto: Sonnet 5.5 · low')
    expect(label(decide('heavy', null, 1))).toBe('auto: Opus 5.5 · high')
  })
})

test('each prompt runs on the model its weight asks for', async ($, on) => {
  const seen = engineBeneath(on)
  await runTurn($, 'what time is it in Tokyo')
  await runTurn($, 'design the architecture for a plugin system with a refactor plan')
  await runTurn($, 'add a --verbose flag to the CLI and its tests')
  expect(seen.models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
  expect(seen.efforts).toEqual(['low', 'high', 'medium'])
  expect(seen.efforts.slice(1)).toEqual(['high', 'medium'])
})

test('a turn is classified once, and its later steps keep the pick', async ($, on) => {
  const seen = engineBeneath(on)
  await runTurn($, 'design the architecture for the new sync engine', { steps: 3 })
  expect(seen.classified).toBe(1)
  expect(seen.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('short replies keep the last pick without asking the classifier', async ($, on) => {
  const seen = engineBeneath(on)
  await runTurn($, 'design the architecture for the new sync engine')
  await runTurn($, 'yes')
  expect(seen.classified).toBe(1)
  expect(seen.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
})

test('subagents and /auto off are left alone', async ($, on) => {
  const seen = engineBeneath(on)
  await runTurn($, 'what time is it in Tokyo', { agentId: 'agent-1' })
  const off = await $.command.run({
    command: 'auto',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(off.text).toMatch(/is off/)
  await runTurn($, 'what time is it in Tokyo')
  expect(seen.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  expect(seen.classified).toBe(0)
})

test('never answers on Haiku', () => {
  for (const tier of ['light', 'standard', 'heavy'] as const) expect(decide(tier, null, 1).model).not.toMatch(/haiku/)
})

test("/model with a model pauses auto, so the pick is the person's", async ($, on) => {
  const seen = engineBeneath(on)
  on('command.run', { command: 'model' }, () => ({ text: 'Set model to Opus 5.5' }))
  on('ui.toast', () => ({ value: undefined }))
  const picked = await $.command.run({
    command: 'model',
    args: 'opus',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(picked.text).toBe('Set model to Opus 5.5')
  await runTurn($, 'what time is it in Tokyo')
  expect(seen.models).toEqual(['claude-opus-5-5'])
  expect(seen.classified).toBe(0)
  const status = await $.command.run({ command: 'auto', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(status.text).toMatch(/is off/)
})

test('a model picked in the /model menu pauses auto from the next turn', async ($, on) => {
  const seen = engineBeneath(on)
  on('ui.toast', () => ({ value: undefined }))
  await runTurn($, 'design the architecture for the new sync engine')
  await runTurn($, 'add a --verbose flag to the CLI and its tests', { model: 'claude-sonnet-5-5' })
  await runTurn($, 'design the architecture for a plugin system with a refactor plan', { model: 'claude-sonnet-5-5' })
  expect(seen.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
  expect(seen.classified).toBe(1)
})
