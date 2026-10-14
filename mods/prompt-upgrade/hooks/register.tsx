import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { PromptUpgradeFlow, PromptUpgradeResult } from '../types'
import {
  HISTORY_SIZE,
  QUESTIONS_SYSTEM,
  REWRITE_SYSTEM,
  answeredCount,
  bigNumber,
  fit,
  newFlow,
  questionsPrompt,
  readQuestions,
  readRewrite,
  rewritePrompt,
  route,
  settledCount,
  wordCount,
} from './logic'

type $ = EngineInterface

const PANE = 'prompt-upgrade'
const TITLE = 'PROMPT UPGRADE'
const COMMAND = 'better'
const QUESTIONS_MODEL = 'haiku'
const REWRITE_MODEL = 'sonnet'
const TIMEOUT_MS = 45_000

const GOLD = '#F2C46D'
const HAIR = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const INK = '#0D1117'

const flowAtom = atom({ plugin: 'prompt-upgrade', key: 'flow' } as const, null)
const autoAtom = atom({ plugin: 'prompt-upgrade', key: 'auto' } as const, false)
const historyAtom = atom({ plugin: 'prompt-upgrade', key: 'history' } as const, [])

export const NARROW = 'The window is too narrow for Prompt Upgrade, so your prompt is back in the box.'

// Which model call this copy of the module has running; a reload starts at none.
let inFlight: string | null = null
let counter = 0

// ───────── State changes (events and presses only) ─────────

async function patch($: $, id: string, fn: (f: PromptUpgradeFlow) => PromptUpgradeFlow) {
  await update($, flowAtom, f => (f != null && f.id === id ? fn(f) : f ?? null))
}

async function current($: $, id: string): Promise<PromptUpgradeFlow | null> {
  const flow = await read($, flowAtom)
  return flow != null && flow.id === id ? flow : null
}

async function setAuto($: $, isOn: boolean) {
  await update($, autoAtom, () => isOn)
  await $.store.set('auto', isOn)
}

async function remember($: $, flow: PromptUpgradeFlow) {
  const item: PromptUpgradeResult = {
    id: flow.id,
    at: Date.now(),
    original: flow.original,
    upgraded: flow.upgraded,
    added: flow.added,
  }
  let kept: PromptUpgradeResult[] = []
  await update($, historyAtom, list => {
    kept = [item, ...(list ?? []).filter(x => x.id !== item.id)].slice(0, HISTORY_SIZE)
    return kept
  })
  await $.store.set('history', kept)
}

async function askQuestions($: $, id: string) {
  const flow = await current($, id)
  if (flow === null || inFlight === `${id}:questions`) return
  inFlight = `${id}:questions`
  try {
    const reply = await $.model.complete({
      model: QUESTIONS_MODEL,
      system: QUESTIONS_SYSTEM,
      prompt: questionsPrompt(flow.original),
      maxTokens: 800,
      effort: 'low',
      timeoutMs: TIMEOUT_MS,
    })
    const questions = reply.isAnswered ? readQuestions(reply.text) : undefined
    if (questions === undefined) {
      const reason = reply.isAnswered ? 'the questions came back in a shape I could not read' : describeFailure(reply)
      await patch($, id, f => (f.step === 'reading' ? { ...f, step: 'error', error: { stage: 'questions', reason } } : f))
      return
    }
    if (questions.length === 0) {
      await patch($, id, f => (f.step === 'reading' ? { ...f, step: 'rewriting', questions: [], answers: [] } : f))
      void rewrite($, id)
      return
    }
    await patch($, id, f =>
      f.step === 'reading' ? { ...f, step: 'questions', questions, answers: questions.map(() => null) } : f,
    )
  } finally {
    if (inFlight === `${id}:questions`) inFlight = null
  }
}

async function rewrite($: $, id: string) {
  const flow = await current($, id)
  if (flow === null || inFlight === `${id}:rewrite`) return
  inFlight = `${id}:rewrite`
  try {
    const reply = await $.model.complete({
      model: REWRITE_MODEL,
      system: REWRITE_SYSTEM,
      prompt: rewritePrompt(flow.original, flow.questions, flow.answers),
      maxTokens: 3000,
      timeoutMs: TIMEOUT_MS,
    })
    const result = reply.isAnswered ? readRewrite(reply.text) : undefined
    if (result === undefined) {
      const reason = reply.isAnswered ? 'the rewrite came back in a shape I could not read' : describeFailure(reply)
      await patch($, id, f => (f.step === 'rewriting' ? { ...f, step: 'error', error: { stage: 'rewrite', reason } } : f))
      return
    }
    await patch($, id, f => (f.step === 'rewriting' ? { ...f, step: 'review', ...result } : f))
    const done = await current($, id)
    if (done !== null && done.step === 'review') await remember($, done)
  } finally {
    if (inFlight === `${id}:rewrite`) inFlight = null
  }
}

function describeFailure(reply: { reason?: string; status?: number | null }): string {
  if (reply.reason === 'aborted') return 'the model took too long to answer'
  if (reply.reason === 'empty-reply') return 'the model sent back nothing'
  if (reply.status === 429) return 'you hit a usage limit'
  if (reply.status === 529 || reply.status === 503) return 'the model is busy right now'
  return 'the model could not be reached'
}

async function openPane($: $) {
  return $.ui.open({ id: PANE, title: 'Prompt Upgrade', focus: true, rows: 32 })
}

/** Starts an upgrade; false when the pane could not be placed (the prompt is then back in the box). */
async function start($: $, text: string, quiet: boolean): Promise<boolean> {
  counter += 1
  const flow = newFlow(`pu-${Date.now().toString(36)}-${counter}`, text)
  await update($, flowAtom, () => flow)
  const placed = await openPane($)
  if (!placed.isPlaced) {
    await update($, flowAtom, () => null)
    await $.ui.close({ id: PANE })
    if (text.trim() !== '') {
      // After a dropped prompt the box clears itself, so fill it a beat later.
      $.clock.after(80, () => void $.prompt.fill({ text, mode: 'replace' }))
    }
    if (!quiet) $.ui.toast(NARROW)
    return false
  }
  if (flow.step === 'reading') void askQuestions($, flow.id)
  return true
}

async function closeAll($: $) {
  await update($, flowAtom, () => null)
  await $.ui.close({ id: PANE })
}

async function cancel($: $) {
  const flow = await read($, flowAtom)
  await closeAll($)
  if (flow != null && flow.original.trim() !== '' && flow.step !== 'history') {
    await $.prompt.fill({ text: flow.original, mode: 'replace' })
  }
}

async function send($: $, text: string) {
  await closeAll($)
  if (text.trim() !== '') await $.prompt.submit({ text })
}

async function settle($: $, id: string, index: number, value: string | null) {
  await patch($, id, f => {
    if (f.step !== 'questions') return f
    const answers = f.questions.map((_, i) => (i === index ? { value } : f.answers[i] ?? null))
    return { ...f, answers, otherFor: f.otherFor === index ? null : f.otherFor }
  })
  const flow = await current($, id)
  if (flow !== null && flow.step === 'questions' && settledCount(flow) === flow.questions.length) {
    await toRewrite($, id)
  }
}

async function toRewrite($: $, id: string) {
  await patch($, id, f =>
    f.step === 'questions'
      ? { ...f, step: 'rewriting', otherFor: null, answers: f.questions.map((_, i) => f.answers[i] ?? { value: null }) }
      : f,
  )
  void rewrite($, id)
}

async function retry($: $, id: string) {
  const flow = await current($, id)
  if (flow === null || flow.error === null) return
  const stage = flow.error.stage
  await patch($, id, f => ({ ...f, error: null, step: stage === 'questions' ? 'reading' : 'rewriting' }))
  void (stage === 'questions' ? askQuestions($, id) : rewrite($, id))
}

async function showHistory($: $) {
  const flow = { ...newFlow('history', ''), step: 'history' as const }
  await update($, flowAtom, () => flow)
  const placed = await openPane($)
  if (!placed.isPlaced) {
    await update($, flowAtom, () => null)
    $.ui.toast('The window is too narrow for the Prompt Upgrade history.')
  }
}

async function reopen($: $, item: PromptUpgradeResult) {
  await update($, flowAtom, () => ({
    ...newFlow(item.id, item.original),
    step: 'review' as const,
    upgraded: item.upgraded,
    added: item.added,
  }))
}

// ───────── Registration ─────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Upgrade a rough prompt before it runs (/better <prompt>, on, off, history)',
      argumentHint: '<prompt> | on | off | history',
    })
    const storedAuto = await $.store.get('auto')
    const storedHistory = await $.store.get('history')
    await update($, autoAtom, () => storedAuto === true)
    await update($, historyAtom, () => (Array.isArray(storedHistory) ? (storedHistory as PromptUpgradeResult[]) : []))

    // A reload mid-step picks the step back up instead of leaving the pane stuck.
    const flow = await read($, flowAtom)
    if (flow != null) {
      void openPane($)
      if (flow.step === 'reading') void askQuestions($, flow.id)
      if (flow.step === 'rewriting') void rewrite($, flow.id)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    const word = arg.toLowerCase()
    if (word === 'on' || word === 'off') {
      await setAuto($, word === 'on')
      return {
        text:
          word === 'on'
            ? 'Prompt Upgrade is on: prompts you type go to the upgrade pane first. Start a prompt with > to send it as is.'
            : 'Prompt Upgrade is off: prompts go straight through. /better <prompt> still upgrades one.',
      }
    }
    if (word === 'history') {
      void showHistory($)
      const count = (await read($, historyAtom)).length
      return { text: count === 0 ? 'No upgrades yet.' : `Showing your last ${count} upgrade${count === 1 ? '' : 's'}.` }
    }
    void start($, arg, false)
    return { text: arg === '' ? 'Type your prompt in the Prompt Upgrade pane.' : 'Upgrading your prompt.' }
  }).catch(() => ({ text: 'Prompt Upgrade hit a problem and did nothing. Your prompt is safe.' }))

  on('prompt.submit', async ($, e, next) => {
    const routing = route({
      text: e.text,
      isAuto: await read($, autoAtom),
      hasCommand: e.command !== undefined,
      isMeta: e.isMeta === true,
      hasAttachments: (e.attachments?.length ?? 0) > 0,
      isBusy: e.turnId !== undefined,
      origin: e.origin.kind,
    })
    if (routing.kind === 'pass') return next(e)
    if (routing.kind === 'strip') return next({ ...e, text: routing.text })
    const isPlaced = await start($, e.text, true)
    return { drop: isPlaced ? 'Sent to Prompt Upgrade.' : NARROW }
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      const flow = await read($, flowAtom)
      await update($, flowAtom, () => null)
      if (flow != null && flow.step !== 'history' && flow.original.trim() !== '') {
        await $.prompt.fill({ text: flow.original, mode: 'replace' })
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Every surface but mobile can take typing.
    const Input = 'Input' in elements ? elements.Input : null
    const noTyping = <Text color={MUTED}>Typing is not available on this screen.</Text>
    const cols = Math.max(20, e.props.bodyColumns)
    const flow = await read($, flowAtom)
    const history = await read($, historyAtom)

    const rule = (n: number, color: string) => <Text color={color}>{'─'.repeat(Math.max(0, n))}</Text>

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={TEXT}>
          {fit(TITLE, cols)}
        </Text>
        <Box>
          <Text color={GOLD}>{'━'.repeat(Math.min(TITLE.length, cols))}</Text>
          {rule(cols - TITLE.length, HAIR)}
        </Box>
      </Box>
    )

    const heading = (label: string) => {
      const caps = fit(label.toUpperCase(), cols - 2)
      return (
        <Box marginTop={1}>
          <Text color={MUTED}>{caps} </Text>
          {rule(cols - caps.length - 1, HAIR)}
        </Box>
      )
    }

    const chip = (key: string, label: string, kind: 'gold' | 'slate' | 'quiet', onPress: (p: UiPressArgument) => void) =>
      kind === 'quiet' ? (
        <Button key={key} plain onPress={onPress}>
          <Text color={MUTED}>{label}</Text>
        </Button>
      ) : (
        <Button key={key} plain onPress={onPress}>
          <Text backgroundColor={kind === 'gold' ? GOLD : HAIR} color={kind === 'gold' ? INK : TEXT} bold={kind === 'gold'}>
            {` ${label} `}
          </Text>
        </Button>
      )

    const card = (key: string, text: string, outline: string, width: number) => (
      <Box key={key} borderStyle="round" borderColor={outline} paddingX={1} width={width} flexDirection="column">
        <Text color={TEXT} wrap="wrap">
          {text}
        </Text>
      </Box>
    )

    const tracker = (stepIndex: number) => {
      const names = ['Your prompt', 'Questions', 'Rewrite', 'Review']
      const isCompact = cols < 56
      const parts = names.map((name, i) => {
        const mark = i < stepIndex ? '✓' : i === stepIndex ? '●' : '○'
        const color = i < stepIndex ? GREEN : i === stepIndex ? GOLD : MUTED
        const label = isCompact && i !== stepIndex ? '' : ` ${name}`
        return (
          <Text key={`t${i}`} color={color} bold={i === stepIndex}>
            {mark}
            {label}
          </Text>
        )
      })
      const joined: unknown[] = []
      parts.forEach((p, i) => {
        if (i > 0) joined.push(<Text key={`s${i}`} color={HAIR}>{isCompact ? ' ' : ' ── '}</Text>)
        joined.push(p)
      })
      return <Box>{joined as never}</Box>
    }

    const cancelChip = chip('cancel', 'Cancel', 'quiet', () => void cancel($))

    if (flow == null) {
      return (
        <Box key="step-none" flexDirection="column" width={cols}>
          {header}
          <Text color={MUTED}>Nothing to upgrade. Type /better followed by a prompt.</Text>
        </Box>
      )
    }

    if (flow.step === 'history') {
      return (
        <Box key={`step-${flow.step}`} flexDirection="column" width={cols}>
          {header}
          {heading(`Last ${history.length} upgrades`)}
          {history.length === 0 && <Text color={MUTED}>No upgrades yet.</Text>}
          {history.map(item => (
            <Button key={`h-${item.id}`} plain onPress={() => void reopen($, item)}>
              <Text color={TEXT}>{fit(item.original.replace(/\s+/g, ' '), cols - 10)}</Text>
              <Text color={MUTED}> {ago(item.at)}</Text>
            </Button>
          ))}
          <Box marginTop={1}>{chip('close', 'Close', 'quiet', () => void closeAll($))}</Box>
        </Box>
      )
    }

    if (flow.step === 'compose') {
      return (
        <Box key={`step-${flow.step}`} flexDirection="column" width={cols}>
          {header}
          {tracker(0)}
          {heading('Your prompt')}
          {Input === null ? noTyping : <Input
            key="compose"
            placeholder="Type a rough prompt and press Enter"
            autoFocus
            onSubmit={(value: string) => {
              if (value.trim() !== '') void start($, value, false)
            }}
          />}
          <Box marginTop={1}>{cancelChip}</Box>
        </Box>
      )
    }

    const stepIndex =
      flow.step === 'reading'
        ? 0
        : flow.step === 'questions'
          ? 1
          : flow.step === 'rewriting'
            ? 2
            : flow.step === 'review'
              ? 3
              : flow.error?.stage === 'questions'
                ? 0
                : 2

    if (flow.step === 'reading' || flow.step === 'rewriting') {
      return (
        <Box key={`step-${flow.step}`} flexDirection="column" width={cols}>
          {header}
          {tracker(stepIndex)}
          {heading('Your prompt')}
          {card('original', flow.original, HAIR, cols)}
          <Text color={MUTED} wrap="wrap">
            {flow.step === 'reading'
              ? 'Reading your prompt and choosing the questions that would help most.'
              : 'Writing the upgraded prompt from your answers.'}
          </Text>
          <Box marginTop={1}>{cancelChip}</Box>
        </Box>
      )
    }

    if (flow.step === 'error') {
      return (
        <Box key={`step-${flow.step}`} flexDirection="column" width={cols}>
          {header}
          {tracker(stepIndex)}
          <Box borderStyle="round" borderColor={AMBER} paddingX={1} flexDirection="column" width={cols} marginTop={1}>
            <Text color={AMBER} bold>
              That did not work: {flow.error?.reason ?? 'something went wrong'}.
            </Text>
            <Text color={TEXT}>Your prompt is safe. Nothing was sent.</Text>
          </Box>
          <Box gap={2} marginTop={1}>
            {chip('retry', 'Try again', 'gold', () => void retry($, flow.id))}
            {chip('original', 'Send my original', 'slate', () => void send($, flow.original))}
            {cancelChip}
          </Box>
        </Box>
      )
    }

    if (flow.step === 'questions') {
      const answered = answeredCount(flow)
      return (
        <Box key={`step-${flow.step}`} flexDirection="column" width={cols}>
          {header}
          {tracker(stepIndex)}
          {heading('Questions')}
          <Box gap={2}>
            <Text color={MUTED}>
              {answered} of {flow.questions.length} answered
            </Text>
            {chip('skip-rest', 'Skip the rest, upgrade now', 'gold', () => void toRewrite($, flow.id))}
            {cancelChip}
          </Box>
          {flow.questions.map((q, i) => {
            const answer = flow.answers[i]
            const isSettled = answer != null
            const custom = answer?.value != null && !q.options.includes(answer.value) ? answer.value : null
            return (
              <Box key={`q${i}`} flexDirection="column" marginTop={1}>
                <Box>
                  <Text backgroundColor={isSettled ? GREEN : GOLD} color={INK} bold>
                    {isSettled ? ' ✓ ' : ` ${i + 1} `}
                  </Text>
                  <Text color={TEXT} bold wrap="wrap">
                    {' '}
                    {q.question}
                  </Text>
                </Box>
                <Box flexWrap="wrap" columnGap={1} marginLeft={4}>
                  {q.options.map((opt, j) =>
                    chip(`q${i}o${j}`, opt, answer?.value === opt ? 'gold' : 'slate', () => void settle($, flow.id, i, opt)),
                  )}
                  {custom !== null
                    ? chip(`q${i}custom`, fit(custom, 40), 'gold', () => void update($, flowAtom, f => (f != null ? { ...f, otherFor: i } : f)))
                    : chip(`q${i}other`, 'Other (type it)', 'slate', () =>
                        void update($, flowAtom, f => (f != null ? { ...f, otherFor: i } : f)),
                      )}
                  {chip(`q${i}skip`, answer?.value === null ? 'Skipped' : 'Skip', 'quiet', () => void settle($, flow.id, i, null))}
                </Box>
                {flow.otherFor === i && (
                  <Box marginLeft={4}>
                    {Input === null ? noTyping : <Input
                      key={`other-${i}`}
                      placeholder="Type your answer and press Enter"
                      autoFocus
                      onSubmit={(value: string) => {
                        if (value.trim() !== '') void settle($, flow.id, i, value.trim())
                      }}
                    />}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    // Review
    const before = wordCount(flow.original)
    const after = wordCount(flow.upgraded)
    const stats: [string, number][] = [
      ['Words before', before],
      ['Words after', after],
      ['Details added', flow.added.length],
    ]
    const tileWidth = (label: string, n: number) => Math.max(label.length, String(n).length * 4 - 1) + 4
    const tilesWidth = stats.reduce((sum, [label, n]) => sum + tileWidth(label, n), 0) + 2 * (stats.length - 1)
    const numbers =
      tilesWidth <= cols ? (
        <Box gap={2}>
          {stats.map(([label, n]) => (
            <Box key={`tile-${label}`} borderStyle="round" borderColor={HAIR} paddingX={1} flexDirection="column" width={tileWidth(label, n)}>
              {bigNumber(n).map((row, r) => (
                <Text key={`r${r}`} color={label === 'Details added' ? GREEN : TEXT}>
                  {row}
                </Text>
              ))}
              <Text color={MUTED}>{label.toUpperCase()}</Text>
            </Box>
          ))}
        </Box>
      ) : (
        <Text color={TEXT}>{fit(`Words ${before} → ${after} · ${flow.added.length} details added`, cols)}</Text>
      )

    const isSideBySide = cols >= 70
    const half = Math.floor((cols - 1) / 2)

    return (
      <Box key={`step-${flow.step}`} flexDirection="column" width={cols}>
        {header}
        {tracker(stepIndex)}
        <Box marginTop={1}>{numbers}</Box>
        <Box gap={2} marginTop={1}>
          {chip('run', 'Run it', 'gold', () => void send($, flow.upgraded))}
          {chip('edit', 'Edit', 'slate', () => void patch($, flow.id, f => ({ ...f, isEditing: true })))}
          {chip('copy', flow.isCopied ? 'Copied' : 'Copy', 'slate', press => {
            void $.ui.copy({ text: flow.upgraded, surface: press.surface }).then(r => {
              if (r.isCopied) void patch($, flow.id, f => ({ ...f, isCopied: true }))
              else $.ui.toast('Could not copy here. Use Edit to select the text.')
            })
          })}
          {cancelChip}
        </Box>
        {flow.isEditing && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={MUTED}>Edit the upgrade. Enter runs it.</Text>
            {Input === null ? noTyping : <Input
              key="edit"
              value={flow.upgraded}
              autoFocus
              onSubmit={(value: string) => void send($, value)}
            />}
          </Box>
        )}
        {flow.added.length > 0 && heading('What I added')}
        {flow.added.map((item, i) => (
          <Text key={`a${i}`} color={TEXT} wrap="wrap">
            <Text color={GREEN}>+ </Text>
            {item}
          </Text>
        ))}
        {heading('Side by side')}
        {isSideBySide ? (
          <Box gap={1}>
            <Box flexDirection="column" width={half}>
              <Text color={MUTED}>YOURS</Text>
              {card('mine', flow.original, HAIR, half)}
            </Box>
            <Box flexDirection="column" width={half}>
              <Text color={GOLD}>UPGRADED</Text>
              {card('upgraded', flow.upgraded, GOLD, half)}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color={MUTED}>YOURS</Text>
            {card('mine', flow.original, HAIR, cols)}
            <Text color={GOLD}>UPGRADED</Text>
            {card('upgraded', flow.upgraded, GOLD, cols)}
          </Box>
        )}
      </Box>
    )
  })
}

function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
