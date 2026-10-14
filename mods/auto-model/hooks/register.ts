import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoModelDecision } from '../types'
import { CLASSIFY_SYSTEM, TIERS, decide, isShortReply, label, readTier } from './logic'

type $ = EngineInterface

const COMMAND = 'auto'
const CLASSIFIER = 'haiku'
const CLASSIFY_TIMEOUT_MS = 8_000
const KEEP_TURNS = 20

const onAtom = atom({ plugin: 'auto-model', key: 'isOn' } as const, true)
const lastAtom = atom({ plugin: 'auto-model', key: 'last' } as const, null)

// What each main turn was asked, and what was picked for it (a turn's later steps reuse it).
const texts = new Map<string, string>()
const decisions = new Map<string, AutoModelDecision>()

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.set(key, value)
  while (map.size > KEEP_TURNS) map.delete(map.keys().next().value as string)
}

async function decideFor($: $, turnId: string, messageCount: number): Promise<AutoModelDecision> {
  const text = texts.get(turnId) ?? ''
  const previous = await read($, lastAtom)
  if (isShortReply(text)) {
    return previous !== null ? { ...previous, why: 'short-reply' } : { tier: 'standard', ...TIERS.standard, why: 'short-reply' }
  }
  const reply = await $.model.complete({
    model: CLASSIFIER,
    system: CLASSIFY_SYSTEM,
    prompt: `<request>\n${text.slice(0, 4000)}\n</request>`,
    maxTokens: 5,
    timeoutMs: CLASSIFY_TIMEOUT_MS,
  })
  return decide(reply.isAnswered ? readTier(reply.text) : undefined, previous, messageCount)
}

async function setOn($: $, isOn: boolean) {
  await update($, onAtom, () => isOn)
  await $.store.set('isOn', isOn)
  if (!isOn) $.ui.status(undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Auto-pick the model per prompt (/auto on, off, or status)',
      argumentHint: 'on | off | status',
    })
    const stored = await $.store.get('isOn')
    await update($, onAtom, () => stored !== false)
    const last = await read($, lastAtom)
    if (stored !== false && last !== null) $.ui.status(label(last))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    if (word === 'on' || word === 'off') {
      await setOn($, word === 'on')
      return {
        text:
          word === 'on'
            ? 'Auto-model is on: each prompt runs on Haiku, Sonnet or Opus by how heavy it is.'
            : 'Auto-model is off: prompts run on the model you chose with /model.',
      }
    }
    const isOn = await read($, onAtom)
    const last = await read($, lastAtom)
    const status = isOn ? 'on' : 'off'
    const lastLine = last === null ? 'No prompt picked yet.' : `Last pick: ${label(last).replace('auto: ', '')} (${last.tier}).`
    return { text: `Auto-model is ${status}. ${lastLine} Use /auto on or /auto off.` }
  }).catch(() => ({ text: 'Auto-model hit a problem and changed nothing.' }))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) remember(texts, e.turnId, e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagents keep the model their definition asks for.
    if (e.agentId !== undefined || !(await read($, onAtom))) return yield* next(e)

    let picked = decisions.get(e.turnId)
    if (picked === undefined) {
      try {
        picked = await decideFor($, e.turnId, e.messageCount)
      } catch {
        return yield* next(e)
      }
      remember(decisions, e.turnId, picked)
      const chosen = picked
      await update($, lastAtom, () => chosen)
      $.ui.status(label(chosen))
    }
    const ask = picked.effort === null ? { ...e, model: picked.model } : { ...e, model: picked.model, effort: picked.effort }
    return yield* next(ask)
  })
}
