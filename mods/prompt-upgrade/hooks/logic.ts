import type { PromptUpgradeAnswer, PromptUpgradeFlow, PromptUpgradeQuestion } from '../types'

export const MAX_QUESTIONS = 3
export const HISTORY_SIZE = 20

const SHORT_REPLIES =
  /^(y|yes|yep|yeah|no|nope|ok|okay|k|sure|thanks|thank you|ty|go|go on|go ahead|do it|continue|keep going|next|done|stop|si|sí|vale|dale|sigue|seguir|continua|continúa|adelante|hazlo|gracias|perfecto|listo|no gracias)[.!\s]*$/i

/** What happens to a prompt typed in the box while automatic mode is on. */
export type Routing = { kind: 'pass' } | { kind: 'strip'; text: string } | { kind: 'upgrade' }

export type SubmitFacts = {
  text: string
  isAuto: boolean
  hasCommand: boolean
  isMeta: boolean
  hasAttachments: boolean
  isBusy: boolean
  origin: string
}

export function route(f: SubmitFacts): Routing {
  const trimmed = f.text.trim()
  // Only the person's own typing is ever held back; the mod's own sends come in as 'plugin'.
  if (!f.isAuto || f.origin !== 'composer') return { kind: 'pass' }
  if (trimmed.startsWith('>')) return { kind: 'strip', text: trimmed.slice(1).trimStart() }
  if (f.hasCommand || f.isMeta || f.hasAttachments || f.isBusy) return { kind: 'pass' }
  if (trimmed === '' || trimmed.startsWith('/')) return { kind: 'pass' }
  if (isShortReply(trimmed)) return { kind: 'pass' }
  return { kind: 'upgrade' }
}

export function isShortReply(text: string): boolean {
  return SHORT_REPLIES.test(text) || wordCount(text) <= 2
}

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(w => w !== '')
  return words.length
}

/** The first {...} block of a model reply, parsed; undefined when there is none. */
export function firstJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const shortText = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** Questions from the model's reply: up to three, each with two to four short options. */
export function readQuestions(reply: string): PromptUpgradeQuestion[] | undefined {
  const json = firstJson(reply) as { questions?: unknown } | undefined
  if (json === undefined || !Array.isArray(json.questions)) return undefined
  const out: PromptUpgradeQuestion[] = []
  for (const raw of json.questions as { question?: unknown; options?: unknown }[]) {
    const question = shortText(raw?.question, 160)
    const options = Array.isArray(raw?.options)
      ? [...new Set(raw.options.map(o => shortText(o, 48)).filter(o => o !== ''))].slice(0, 4)
      : []
    if (question !== '' && options.length >= 2) out.push({ question, options })
    if (out.length === MAX_QUESTIONS) break
  }
  return out
}

/** The upgraded prompt and what it added, from the model's reply. */
export function readRewrite(reply: string): { upgraded: string; added: string[] } | undefined {
  const json = firstJson(reply) as { prompt?: unknown; added?: unknown } | undefined
  if (json === undefined || typeof json.prompt !== 'string') return undefined
  const upgraded = json.prompt.trim()
  if (upgraded === '') return undefined
  const added = Array.isArray(json.added)
    ? json.added.map(a => shortText(a, 120)).filter(a => a !== '').slice(0, 8)
    : []
  return { upgraded, added }
}

export const QUESTIONS_SYSTEM = [
  'You help a person sharpen a rough prompt before they send it to an AI assistant.',
  'Ask at most 3 multiple-choice questions whose answers would most improve the result:',
  'the goal, who it is for, the format, the scope, or what "done" looks like.',
  'Each question has 2 to 4 options of at most 5 words. Skip anything the prompt already says.',
  'If no question would help, return an empty list.',
  'Write the questions in the same language as the prompt.',
  'Reply with JSON only, no prose: {"questions":[{"question":"...","options":["...","..."]}]}',
].join('\n')

export const REWRITE_SYSTEM = [
  'You rewrite a rough prompt into a great one that the same person could have typed.',
  'Rules:',
  '- Keep exactly what they meant. Do not change the task.',
  '- Add a clear goal, who it is for, the format, and what "done" looks like.',
  '- Use the answers they gave. Leave out anything they skipped.',
  '- Never invent facts, names, numbers or prices. Where something is unknown, write a [placeholder] in square brackets.',
  '- Write it as one request in plain language, in the same language as the original, addressed to the assistant.',
  '- No headings like "Goal:" unless the request is long enough to need them.',
  '"added" lists each thing you added, a few words each.',
  'Reply with JSON only, no prose: {"prompt":"...","added":["...","..."]}',
].join('\n')

export function questionsPrompt(original: string): string {
  return `The rough prompt:\n<prompt>\n${original}\n</prompt>`
}

export function rewritePrompt(original: string, questions: PromptUpgradeQuestion[], answers: (PromptUpgradeAnswer | null)[]): string {
  const answered = questions
    .map((q, i) => ({ q: q.question, a: answers[i]?.value }))
    .filter((x): x is { q: string; a: string } => typeof x.a === 'string' && x.a !== '')
  const lines = answered.map(x => `- ${x.q} → ${x.a}`)
  return [
    `The rough prompt:\n<prompt>\n${original}\n</prompt>`,
    lines.length > 0 ? `Their answers:\n${lines.join('\n')}` : 'They answered no questions.',
  ].join('\n\n')
}

export function answeredCount(flow: PromptUpgradeFlow): number {
  return flow.questions.filter((_, i) => flow.answers[i] != null && flow.answers[i]?.value !== null).length
}

export function settledCount(flow: PromptUpgradeFlow): number {
  return flow.questions.filter((_, i) => flow.answers[i] != null).length
}

export function newFlow(id: string, original: string): PromptUpgradeFlow {
  return {
    id,
    step: original.trim() === '' ? 'compose' : 'reading',
    original,
    questions: [],
    answers: [],
    otherFor: null,
    upgraded: '',
    added: [],
    isEditing: false,
    isCopied: false,
    error: null,
  }
}

// ───────── Drawing helpers (pure) ─────────

const DIGITS: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
}

/** A number three rows tall in heavy box-drawing characters. */
export function bigNumber(n: number): [string, string, string] {
  const digits = String(Math.max(0, Math.round(n))).split('')
  const rows: [string, string, string] = ['', '', '']
  for (let r = 0; r < 3; r++) rows[r] = digits.map(d => DIGITS[d]?.[r] ?? '   ').join(' ')
  return rows
}

export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return width === 1 ? '…' : `${text.slice(0, width - 1)}…`
}
