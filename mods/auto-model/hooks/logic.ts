import type { AutoModelDecision, AutoModelTier } from '../types'

/**
 * Full model ids: `turn.step` sends its model to the API as given, and the API
 * answers 404 to an alias such as `haiku` (only `$.model.complete` resolves those).
 * Sonnet is the floor: Haiku only sorts the prompt, it never answers one.
 */
export const TIERS: Record<AutoModelTier, { model: string; effort: AutoModelDecision['effort'] }> = {
  light: { model: 'claude-sonnet-5-5', effort: 'low' },
  standard: { model: 'claude-sonnet-5-5', effort: 'medium' },
  heavy: { model: 'claude-opus-5-5', effort: 'high' },
}

const RANK: Record<AutoModelTier, number> = { light: 0, standard: 1, heavy: 2 }

/**
 * Past this many messages a switch to a lighter model costs more (the new
 * model re-reads the whole conversation uncached) than it saves, so the
 * session keeps its heavier model.
 */
export const DOWNGRADE_MAX_MESSAGES = 12

const SHORT_REPLIES =
  /^(y|yes|yep|no|ok|okay|sure|thanks|go|go on|go ahead|do it|continue|keep going|next|si|sí|vale|dale|sigue|continua|continúa|adelante|hazlo|gracias|perfecto|listo)[.!\s]*$/i

export function isShortReply(text: string): boolean {
  return text.trim() === '' || SHORT_REPLIES.test(text.trim())
}

export const CLASSIFY_SYSTEM = [
  'You sort a request to a coding assistant by how much thinking it needs. Answer with one word.',
  'light: a quick question, a lookup, a one-line command, a tiny edit, chit-chat, a summary of something short.',
  'standard: normal coding work, a bug with a clear cause, a small feature, writing a document, configuring a tool.',
  'heavy: architecture or design, a multi-file feature or refactor, a hard or unclear bug, security review, research across many sources, anything where a mistake is costly.',
  'Answer light, standard or heavy.',
].join('\n')

export function readTier(reply: string): AutoModelTier | undefined {
  const word = reply.toLowerCase().match(/\b(light|standard|heavy)\b/)
  return word ? (word[1] as AutoModelTier) : undefined
}

/** The decision for a turn, given what the classifier said and what ran last turn. */
export function decide(
  classified: AutoModelTier | undefined,
  previous: AutoModelDecision | null,
  messageCount: number,
): AutoModelDecision {
  if (classified === undefined) {
    return previous !== null ? { ...previous, why: 'kept' } : { tier: 'standard', ...TIERS.standard, why: 'fallback' }
  }
  if (previous !== null && RANK[classified] < RANK[previous.tier] && messageCount > DOWNGRADE_MAX_MESSAGES) {
    return { ...previous, why: 'kept' }
  }
  return { tier: classified, ...TIERS[classified], why: 'classified' }
}

/** `claude-haiku-5-5` → `Haiku 5.5`. */
export function displayName(model: string): string {
  const m = model.match(/^claude-([a-z]+)-(\d+)-(\d+)/)
  const base = m ? `${m[1]} ${m[2]}.${m[3]}` : model
  return base.charAt(0).toUpperCase() + base.slice(1)
}

export function label(d: AutoModelDecision): string {
  const name = displayName(d.model)
  return d.effort === null ? `auto: ${name}` : `auto: ${name} · ${d.effort}`
}
