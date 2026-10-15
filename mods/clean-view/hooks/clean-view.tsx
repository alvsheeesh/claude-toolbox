import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderChildren, RenderInput, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewPhase, CleanViewTask } from '../types'

const PLUGIN = 'clean-view'
const STORE_KEY = 'cleanViewEnabled'
const PLAN_TOOL = 'plan_steps'
const REPORT_TOOL = 'report_progress'
const COMMAND = 'simple'

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)
// The Toolbox's side panel draws the steps while it shows; the band then leaves them to it.
const toolboxHostingAtom = atom({ plugin: 'toolbox', key: 'hosting' } as const, false)

const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion'])

const MAX_NAME = 40
const METER_CELLS = 10
const TICK_MS = 250
const COLLAPSE_MS = 5000
const FAILURES_BEFORE_STUCK = 3

const PLACEHOLDER_TITLE = 'Working on your request'
const PLACEHOLDER_STEPS = ['Understand your request', 'Plan the steps']

export const NEEDS_OK = 'Claude needs your OK to continue'
export const NEEDS_ANSWER = 'Claude has a question for you'
export const NEEDS_REPLY = 'Claude is waiting for your reply'
export const SAID_NO = 'you said no to a step, so Claude paused'
export const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
export const REFUSED = "Claude couldn't help with that request"

const CODE_EXTENSIONS =
  'tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|fish|ps1|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|md|mdx|css|scss|sass|less|html?|vue|svelte|sql|xml|gradle|lua|dart|scala|ex|exs|r'
const FILE_NAME = new RegExp(`\\.(${CODE_EXTENSIONS})\\b`, 'i')

type $ = EngineInterface
type Patch = (list: CleanViewChecklist) => CleanViewChecklist

// ───────── Plain names ─────────

/** The one cleaner every step and job name goes through. */
export function cleanName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  const words = text
    .replace(/`[^`]*`?/g, ' ')
    .split(/\s+/)
    .filter(word => word !== '' && !/[/\\]/.test(word) && !FILE_NAME.test(word))
  let name = words.join(' ').replace(/\s+/g, ' ').trim()
  if (name === '') {
    return 'Working on it'
  }
  name = name.charAt(0).toUpperCase() + name.slice(1)
  if (name.length > MAX_NAME) {
    const room = name.slice(0, MAX_NAME - 1)
    const cut = room.lastIndexOf(' ')
    name = `${(cut > 0 ? room.slice(0, cut) : room).replace(/[\s,;:.–-]+$/, '')}…`
  }
  return name
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** One calm sentence for an API error, from the text the turn ended with. */
export function calmError(answer: string): string {
  if (/rate.?limit|usage limit|limit reached|\b429\b/i.test(answer)) {
    return 'you hit your usage limit, try again a little later'
  }
  if (/overloaded|\b529\b|\b503\b/i.test(answer)) {
    return "Claude's servers are busy, try again in a minute"
  }
  if (/too long|context (window|length|limit)|too many tokens|maximum context/i.test(answer)) {
    return 'type /compact and try again'
  }
  if (/\b401\b|\b403\b|auth|log ?in|api key|credential|oauth|token (expired|revoked)/i.test(answer)) {
    return 'type /login'
  }
  if (/network|connect|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|timed? ?out/i.test(answer)) {
    return 'the internet connection dropped'
  }
  return "something went wrong on Claude's side, try again"
}

// ───────── Checklist logic (pure) ─────────

let idCounter = 0
function newId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

function task(name: string, status: CleanViewTask['status'], id = newId('step')): CleanViewTask {
  return { id, name, status, percent: status === 'done' ? 100 : 0, hasReported: false }
}

export function newJob(jobId: string, startedAt: number): CleanViewChecklist {
  return {
    jobId,
    title: PLACEHOLDER_TITLE,
    phase: 'working',
    tasks: PLACEHOLDER_STEPS.map((name, i) => task(name, i === 0 ? 'active' : 'upcoming', `ph-${i}`)),
    hasPlan: false,
    needsYouReason: null,
    stuckReason: null,
    startedAt,
    finishedAt: null,
    isCollapsed: false,
  }
}

const isPlaceholder = (t: CleanViewTask) => t.id.startsWith('ph-')

export function applyPlan(list: CleanViewChecklist, steps: readonly unknown[]): CleanViewChecklist {
  const names = steps.map(cleanName).slice(0, 8)
  return {
    ...list,
    tasks: names.map((name, i) => task(name, i === 0 ? 'active' : 'upcoming')),
    hasPlan: true,
    phase: 'working',
    needsYouReason: null,
    stuckReason: null,
  }
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function applyProgress(list: CleanViewChecklist, rawName: unknown, rawPercent: unknown): CleanViewChecklist {
  const name = cleanName(rawName)
  const n = Number(rawPercent)
  const percent = Math.round(Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0)))
  let tasks = list.tasks.filter(t => list.hasPlan || !isPlaceholder(t))
  let index = tasks.findIndex(t => sameName(t.name, name))
  if (index === -1) {
    // A step that isn't in the plan becomes the current step.
    const firstOpen = tasks.findIndex(t => t.status !== 'done')
    index = firstOpen === -1 ? tasks.length : firstOpen
    tasks = [...tasks.slice(0, index), task(name, 'upcoming'), ...tasks.slice(index)]
  }
  tasks = tasks.map((t, i): CleanViewTask => {
    if (i < index) return { ...t, status: 'done', percent: 100 }
    if (i === index) {
      return percent >= 100
        ? { ...t, status: 'done', percent: 100, hasReported: true }
        : { ...t, status: 'active', percent, hasReported: true }
    }
    if (i === index + 1 && percent >= 100 && t.status !== 'done') {
      return { ...t, status: 'active', percent: 0, hasReported: false }
    }
    return t.status === 'active' ? { ...t, status: 'upcoming' } : t
  })
  return { ...list, tasks, hasPlan: true }
}

type Todo = { content?: unknown; status?: unknown }

export function applyTodos(list: CleanViewChecklist, todos: unknown): CleanViewChecklist {
  if (!Array.isArray(todos)) return list
  const tasks = (todos as Todo[]).map((todo): CleanViewTask => {
    const name = cleanName(todo.content)
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'
    const before = list.tasks.find(t => sameName(t.name, name))
    const kept = before !== undefined && before.status === status ? before : undefined
    return kept ?? task(name, status)
  })
  return { ...list, tasks: withOneActive(tasks), hasPlan: tasks.length > 0 || list.hasPlan }
}

/** With nothing marked as current, the first open step is. */
function withOneActive(tasks: CleanViewTask[]): CleanViewTask[] {
  if (tasks.some(t => t.status === 'active')) return tasks
  const first = tasks.findIndex(t => t.status === 'upcoming')
  return first === -1 ? tasks : tasks.map((t, i) => (i === first ? { ...t, status: 'active' } : t))
}

export function applyTaskCreate(list: CleanViewChecklist, subject: unknown, taskId: string | undefined): CleanViewChecklist {
  const base = list.hasPlan ? list.tasks : list.tasks.filter(t => !isPlaceholder(t))
  const created = task(cleanName(subject), 'upcoming', taskId !== undefined ? `task-${taskId}` : newId('task'))
  return { ...list, tasks: withOneActive([...base, created]), hasPlan: true }
}

export function applyTaskUpdate(list: CleanViewChecklist, taskId: unknown, status: unknown, subject: unknown): CleanViewChecklist {
  const id = `task-${String(taskId)}`
  if (status === 'deleted') {
    return { ...list, tasks: withOneActive(list.tasks.filter(t => t.id !== id)) }
  }
  const tasks = list.tasks.map((t): CleanViewTask => {
    if (t.id !== id) return t
    const name = typeof subject === 'string' && subject !== '' ? cleanName(subject) : t.name
    if (status === 'completed') return { ...t, name, status: 'done', percent: 100 }
    if (status === 'in_progress') return { ...t, name, status: 'active' }
    if (status === 'pending') return { ...t, name, status: 'upcoming' }
    return { ...t, name }
  })
  return { ...list, tasks: withOneActive(tasks) }
}

export function finish(list: CleanViewChecklist, at: number): CleanViewChecklist {
  return {
    ...list,
    phase: 'done',
    tasks: list.tasks.map(t => ({ ...t, status: 'done', percent: 100 })),
    needsYouReason: null,
    stuckReason: null,
    finishedAt: at,
  }
}

// ───────── Engine glue ─────────

let ticker: Timer | null = null
let failuresInARow = 0

const isAnimated = (phase: CleanViewPhase | undefined) => phase === 'working' || phase === 'needs-you'

/** The 250ms clock runs only while a job is working or waiting on the person. */
function syncTicker($: $, phase: CleanViewPhase | undefined) {
  if (isAnimated(phase) && ticker === null) {
    ticker = $.clock.every(TICK_MS, () => void update($, tickAtom, n => (n ?? 0) + 1))
  } else if (!isAnimated(phase) && ticker !== null) {
    ticker.cancel()
    ticker = null
  }
}

async function patch($: $, fn: Patch): Promise<CleanViewChecklist | null> {
  let next: CleanViewChecklist | null = null
  await update($, checklistAtom, list => {
    next = list === null || list === undefined ? null : fn(list)
    return next
  })
  const phase = (next as CleanViewChecklist | null)?.phase
  syncTicker($, phase)
  return next
}

async function setEnabled($: $, isOn: boolean) {
  await update($, enabledAtom, () => isOn)
  await $.store.set(STORE_KEY, isOn)
}

async function toggle($: $, isOn?: boolean) {
  const target = isOn ?? !(await read($, enabledAtom))
  await setEnabled($, target)
  $.ui.toast(target ? 'Clean View is on: technical details are hidden' : 'Clean View is off: everything is shown')
  return target
}

const toolName = (raw: unknown) => String(raw)
const isOwnTool = (tool: string, name: string) => tool.startsWith('mcp__') && tool.endsWith(`__${name}`) && tool.includes('clean')

async function nameJob($: $, jobId: string, request: string) {
  const answer = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 40,
    timeoutMs: 15000,
    system: 'You name jobs for a progress checklist read by non-technical people.',
    prompt:
      'Give this request a name of 2 to 6 plain English words that starts with a verb, like "Build my landing page". ' +
      'No file names, code, quotes or punctuation. Reply with the name only.\n\nRequest:\n' +
      request.slice(0, 2000),
  })
  if (!answer.isAnswered) return
  const title = cleanName(answer.text.split('\n')[0]?.replace(/^["'`]+|["'`.]+$/g, ''))
  await patch($, list => (list.jobId === jobId ? { ...list, title } : list))
}

const PROMPT_SECTION = (hasTodos: boolean, planTool: string, reportTool: string) =>
  [
    '# Clean View',
    'The person sees a simple checklist of your work instead of tool calls, diffs and command output.',
    `- For every request, even a quick question, call \`${planTool}\` first with every step of the job, 2 to 8 short names in order. If it is deferred, load it with ToolSearch first.`,
    `- Then call \`${reportTool}\` as real progress happens, and with percent 100 the moment a step finishes.`,
    '- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".',
    '- Never put file paths, file names, commands, code or tool names in a step name.',
    ...(hasTodos ? ['- You can use your to-do list (TodoWrite or TaskCreate) as the plan instead; the same naming rules apply.'] : []),
  ].join('\n')

async function needsYou($: $, reason: string) {
  const list = await read($, checklistAtom)
  if (list !== null && isAnimated(list.phase)) {
    await patch($, l => ({ ...l, phase: 'needs-you', needsYouReason: reason }))
  }
}

export function registerCleanView(on: On) {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)
    if (typeof stored === 'boolean') {
      await update($, enabledAtom, () => stored)
    }
    await $.tool.register({
      name: PLAN_TOOL,
      description:
        'Clean View: lay out every step of the job before doing anything else, 2 to 8 short plain-English names in order (each under 40 characters, starting with a verb, no file names, paths, commands or code). The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
        required: ['steps'],
      },
    })
    await $.tool.register({
      name: REPORT_TOOL,
      description:
        'Clean View: report progress on the current step by its plan name. Send percent 100 the moment a step finishes; the next step then starts by itself. A name not in the plan becomes a new step.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string' }, percent: { type: 'number', minimum: 0, maximum: 100 } },
        required: ['task', 'percent'],
      },
    })
    await $.command.register({
      name: COMMAND,
      description: 'Turn Clean View on or off (no argument flips it)',
      argumentHint: '[on|off]',
      immediate: true,
    })
    syncTicker($, (await read($, checklistAtom))?.phase)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const target = arg === 'on' ? true : arg === 'off' ? false : undefined
    if (arg !== '' && target === undefined) {
      return { text: 'Use /simple on, /simple off, or /simple to flip it.' }
    }
    const isOn = await toggle($, target)
    return { text: isOn ? 'Clean View is on.' : 'Clean View is off.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabledAtom))) return composed
    const planTool = e.tools.find(t => isOwnTool(t, PLAN_TOOL)) ?? PLAN_TOOL
    const reportTool = e.tools.find(t => isOwnTool(t, REPORT_TOOL)) ?? REPORT_TOOL
    const hasTodos = e.tools.includes('TodoWrite') || e.tools.includes('TaskCreate')
    return {
      ...composed,
      sections: [
        ...composed.sections,
        { id: `${PLUGIN}:plan`, text: PROMPT_SECTION(hasTodos, planTool, reportTool), scope: 'session' as const },
      ],
    }
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    if (text !== '' && !text.startsWith('/')) {
      const current = await read($, checklistAtom)
      if (current !== null && current.phase === 'needs-you') {
        // The person replied to a job that was waiting on them: carry on.
        await patch($, list => ({ ...list, phase: 'working', needsYouReason: null }))
      } else {
        failuresInARow = 0
        const jobId = e.turnId
        const startedAt = await $.clock.now()
        await update($, checklistAtom, () => newJob(jobId, startedAt))
        syncTicker($, 'working')
        void nameJob($, jobId, text).catch(() => undefined)
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = toolName(e.tool)
    const args = e as unknown as Record<string, unknown>
    const isMain = e.agentId === undefined

    if (isOwnTool(tool, PLAN_TOOL)) {
      const steps = Array.isArray(args.steps) ? args.steps : []
      if (steps.length === 0) return { deny: 'plan_steps needs at least one step name.' }
      if ((await read($, checklistAtom)) === null) {
        const startedAt = await $.clock.now()
        await update($, checklistAtom, () => newJob(newId('job'), startedAt))
      }
      const list = await patch($, l => applyPlan(l, steps))
      const n = list?.tasks.length ?? 0
      return { result: `Planned ${n} step${n === 1 ? '' : 's'}. The first one has started.` }
    }

    if (isOwnTool(tool, REPORT_TOOL)) {
      const n = Number(args.percent)
      const percent = Math.round(Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0)))
      await patch($, l => applyProgress(l, args.task, percent))
      return { result: `Progress noted: ${percent}%.` }
    }

    const isOn = await read($, enabledAtom)
    const list = await read($, checklistAtom)
    if (isOn && isMain && list !== null && isAnimated(list.phase) && !list.hasPlan && !ALWAYS_ALLOWED.has(tool)) {
      return {
        deny:
          'Clean View: call plan_steps first to lay out the steps of this job in plain words (load it with ToolSearch if it is deferred), then try again.',
      }
    }

    if (list !== null && list.phase === 'needs-you' && list.needsYouReason !== NEEDS_REPLY) {
      await patch($, l => ({ ...l, phase: 'working', needsYouReason: null }))
    }
    if (tool === 'AskUserQuestion' && list !== null) {
      await patch($, l => ({ ...l, phase: 'needs-you', needsYouReason: NEEDS_ANSWER }))
    }

    const result = await next(e)

    if (list === null) return result
    if (tool === 'TodoWrite' && !result.isError && !('deny' in result && result.deny !== undefined)) {
      await patch($, l => applyTodos(l, args.todos))
    } else if (tool === 'TaskCreate' && !result.isError) {
      const id = /\b(?:#|id[^0-9]{0,4})(\d+)/i.exec(String(result.text ?? ''))?.[1]
      await patch($, l => applyTaskCreate(l, args.subject, id))
    } else if (tool === 'TaskUpdate' && !result.isError) {
      await patch($, l => applyTaskUpdate(l, args.taskId, args.status, args.subject))
    }

    const after = await read($, checklistAtom)
    if (after?.phase === 'needs-you' && after.needsYouReason !== NEEDS_REPLY) {
      await patch($, l => ({ ...l, phase: 'working', needsYouReason: null }))
    }

    if (isMain) {
      const errorText = result.isError ? String(result.text ?? result.result ?? '') : ''
      if ('deny' in result && result.deny !== undefined) {
        // A refusal by a hook or rule is not a failing step.
      } else if (result.isError && /doesn't want to proceed|rejected|user denied|permission denied by user/i.test(errorText)) {
        failuresInARow = 0
        await patch($, l => ({ ...l, phase: 'stuck', stuckReason: SAID_NO }))
      } else if (result.isError) {
        failuresInARow += 1
        if (failuresInARow >= FAILURES_BEFORE_STUCK) {
          await patch($, l => ({ ...l, phase: 'stuck', stuckReason: KEEPS_FAILING }))
        }
      } else {
        failuresInARow = 0
        if (after?.phase === 'stuck') {
          await patch($, l => ({ ...l, phase: 'working', stuckReason: null }))
        }
      }
    }
    return result
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await needsYou($, NEEDS_OK)
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    const kind = String(e.notification_type)
    if (/permission/i.test(kind)) {
      await needsYou($, NEEDS_OK)
    } else if (/elicitation|question/i.test(kind)) {
      await needsYou($, NEEDS_ANSWER)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const list = await read($, checklistAtom)
    if (list === null || list.phase === 'done' || list.phase === 'stopped') return result
    const now = await $.clock.now()

    if (e.reason === 'error') {
      await patch($, l => ({ ...l, phase: 'stuck', stuckReason: calmError(e.answer), finishedAt: now }))
    } else if (e.reason === 'refusal') {
      await patch($, l => ({ ...l, phase: 'stuck', stuckReason: REFUSED, finishedAt: now }))
    } else if (e.reason === 'aborted') {
      if (list.phase === 'stuck' && list.stuckReason === SAID_NO) {
        await patch($, l => ({ ...l, finishedAt: now }))
      } else {
        await patch($, l => ({ ...l, phase: 'stopped', finishedAt: now }))
      }
    } else if (list.hasPlan && list.tasks.some(t => t.status !== 'done')) {
      await patch($, l => ({ ...l, phase: 'needs-you', needsYouReason: NEEDS_REPLY }))
    } else {
      const jobId = list.jobId
      await patch($, l => finish(l, now))
      $.clock.after(COLLAPSE_MS, () => {
        void patch($, l => (l.jobId === jobId && l.phase === 'done' ? { ...l, isCollapsed: true } : l))
      })
    }
    return result
  })

  // ───────── Hide the technical rows ─────────

  on('ui.render', { component: ['ToolUse', 'ToolResult', 'ToolGroup'] }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  // ───────── The band above the prompt ─────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await isHostedByToolbox($))) return next(e)
    // Other mods draw in this band too: theirs goes under ours instead of being hidden.
    const mine = await drawBand($, e)
    const below = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}

async function drawBand($: $, e: RenderInput<'AbovePrompt'>) {
  const isOn = await read($, enabledAtom)
  const list = await read($, checklistAtom)
  const frame = await read($, tickAtom)
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(20, e.props.bodyColumns)

  const button = (
    <Button
      key="clean-view-toggle"
      label={isOn ? '● Clean View: ON' : '○ Clean View: OFF'}
      variant={isOn ? 'primary' : 'secondary'}
      onPress={() => void toggle($)}
    />
  )
  const headerRow = (left: RenderChildren) => (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Box flexShrink={1}>{left}</Box>
      {button}
    </Box>
  )

  if (!isOn || list === null) {
    return headerRow(<Text> </Text>)
  }

  const now = await $.clock.now()
  const elapsed = formatDuration((list.finishedAt ?? now) - list.startedAt)
  const header = headerFor(Text, list, elapsed)

  if (list.phase === 'done' && list.isCollapsed) {
    return headerRow(header)
  }

  // Icon (2) + name + gap (1) + meter (10) + gap (2) + label (7) + right margin (1).
  const nameWidth = Math.max(6, Math.min(MAX_NAME, width - 23))
  const firstUpcoming = list.tasks.findIndex(t => t.status === 'upcoming')

  return (
    <Box flexDirection="column" width={width}>
      {headerRow(header)}
      {list.tasks.map((t, i) => {
        const isActive = t.status === 'active'
        const isDone = t.status === 'done'
        // Waiting on the person: the step is paused, so nothing on it moves or reads as work.
        const isPaused = isActive && list.phase === 'needs-you'
        const icon = isDone ? '✓' : isActive ? (isPaused ? '‖' : '▶') : '○'
        const label = isDone
          ? 'Done'
          : isPaused
            ? 'Paused'
            : isActive
            ? t.hasReported
              ? `${t.percent}%`
              : 'Working'
            : i === firstUpcoming
              ? 'Next'
              : 'Up next'
        return (
          <Box key={t.id} flexDirection="row">
            <Text color={isDone ? 'green' : undefined} dimColor={!isDone && !isActive}>
              {`${icon} `}
            </Text>
            <Text bold={isActive} dimColor={!isActive} wrap="truncate">
              {fit(t.name, nameWidth)}
            </Text>
            <Text color={isDone ? 'green' : isPaused ? 'yellow' : isActive ? 'cyan' : undefined} dimColor={!isDone && !isActive}>
              {` ${meter(t, isActive && !isPaused && !t.hasReported, frame)}  `}
            </Text>
            <Text color={isPaused ? 'yellow' : undefined} dimColor={!isActive}>
              {label}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** A read of a plugin not loaded is refused: without the Toolbox, the band draws the steps. */
async function isHostedByToolbox($: $) {
  try {
    return await read($, toolboxHostingAtom)
  } catch {
    return false
  }
}

function fit(name: string, width: number): string {
  if (name.length <= width) return name.padEnd(width)
  return `${name.slice(0, Math.max(0, width - 1))}…`
}

export function meter(t: CleanViewTask, isSweeping: boolean, frame: number): string {
  if (isSweeping) {
    const span = 3
    const at = frame % (METER_CELLS + span)
    return Array.from({ length: METER_CELLS }, (_, i) => (i >= at - span && i < at ? '▓' : '░')).join('')
  }
  const filled = t.status === 'done' ? METER_CELLS : Math.round((t.percent / 100) * METER_CELLS)
  return '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled)
}

function headerFor(Text: any, list: CleanViewChecklist, elapsed: string) {
  switch (list.phase) {
    case 'needs-you':
      return (
        <Text wrap="truncate">
          <Text inverse bold color="yellow">
            {' Needs you '}
          </Text>
          {` ${list.needsYouReason ?? NEEDS_REPLY}`}
        </Text>
      )
    case 'stuck':
      return (
        <Text wrap="truncate">
          <Text color="red" bold>
            ⚠ Stuck:
          </Text>
          {` ${list.stuckReason ?? KEEPS_FAILING}`}
        </Text>
      )
    case 'stopped':
      return (
        <Text wrap="truncate">
          <Text bold>■ Stopped</Text>
          {` · ${list.title} · you pressed Esc`}
        </Text>
      )
    case 'done':
      return (
        <Text wrap="truncate">
          <Text color="green" bold>
            ✓ All done
          </Text>
          {` · ${list.title} · took ${elapsed}`}
        </Text>
      )
    default:
      return (
        <Text wrap="truncate">
          <Text bold>{list.title}</Text>
          <Text dimColor>{` · ${elapsed}`}</Text>
        </Text>
      )
  }
}
