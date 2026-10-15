import type { BurnMeterSpend, CleanViewSteps, CleanViewStep, ToolboxMod } from '../types'

export const MARKETPLACE = 'claude-toolbox'
/** The panel never lists itself, so it cannot be switched off from inside. */
export const SELF = `toolbox@${MARKETPLACE}`

type Listed = { id?: unknown; enabled?: unknown }

/** `clean-view@claude-toolbox` → `Clean View`. */
export function modName(id: string): string {
  return id
    .split('@')[0]
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** The toolbox's mods from `claude plugin list --json`, keeping what this session loaded. */
export function readMods(json: string, loaded: ReadonlyMap<string, boolean>): ToolboxMod[] {
  const list: Listed[] = JSON.parse(json)
  return list
    .filter(p => typeof p.id === 'string' && p.id.endsWith(`@${MARKETPLACE}`) && p.id !== SELF)
    .map(p => {
      const id = p.id as string
      const isEnabled = p.enabled === true
      return { id, name: modName(id), isEnabled, wasEnabled: loaded.get(id) ?? isEnabled }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** `claude-haiku-5-5` → `Haiku 5.5`. */
export function displayName(model: string): string {
  const m = model.match(/^claude-([a-z]+)-(\d+)-(\d+)/)
  const base = m ? `${m[1]} ${m[2]}.${m[3]}` : model
  return base.charAt(0).toUpperCase() + base.slice(1)
}

const WHY: Record<string, string> = {
  light: 'light task',
  standard: 'normal task',
  heavy: 'heavy task',
}

/** Why auto-model picked it, in a few plain words. */
export function autoReason(tier: string, why: string): string {
  if (why === 'short-reply') return 'short reply, kept the last pick'
  if (why === 'kept') return 'kept the heavier model mid-conversation'
  if (why === 'fallback') return 'no clear answer, used the default'
  return WHY[tier] ?? tier
}

/** The line over Clean View's steps: what the job is, or why it waits. */
export function stepsHeader(steps: CleanViewSteps): string {
  if (steps.phase === 'needs-you') return `Needs you: ${steps.needsYouReason ?? 'waiting for your reply'}`
  if (steps.phase === 'stuck') return steps.stuckReason ?? 'Trying another way'
  if (steps.phase === 'stopped') return 'Stopped'
  if (steps.phase === 'done') return `All done: ${steps.title}`
  return steps.title
}

/** One step as the panel draws it: its mark, its word and their color. */
export function stepRow(step: CleanViewStep, isWaiting: boolean): { icon: string; label: string; color?: string } {
  if (step.status === 'done') return { icon: '✓', label: 'Done', color: 'green' }
  if (step.status === 'upcoming') return { icon: '○', label: 'Next' }
  if (isWaiting) return { icon: '‖', label: 'Paused', color: 'yellow' }
  return { icon: '▶', label: step.hasReported ? `${step.percent}%` : 'Working', color: 'cyan' }
}

/**
 * Clean View's steps in one line: a mark per step, the step under way, then how far along.
 * `✓✓▶○  Move the panels · 40% · 2/4`; null once a finished job has folded away.
 */
export function stepsLine(
  steps: CleanViewSteps,
): { marks: string; title: string; detail: string; color?: string; isAlert: boolean } | null {
  if (steps.phase === 'done' && steps.isCollapsed) return null
  const isWaiting = steps.phase === 'needs-you'
  const marks = steps.tasks.map(t => stepRow(t, isWaiting).icon).join('')
  const done = steps.tasks.filter(t => t.status === 'done').length
  const count = `${done}/${steps.tasks.length}`
  const active = steps.tasks.find(t => t.status === 'active')
  if (steps.phase !== 'working' || active === undefined) {
    const color = steps.phase === 'done' ? 'green' : isWaiting ? 'yellow' : undefined
    return { marks, title: stepsHeader(steps), detail: count, color, isAlert: isWaiting || steps.phase === 'stuck' }
  }
  return { marks, title: active.name, detail: `${stepRow(active, false).label} · ${count}`, color: 'cyan', isAlert: false }
}

/** Burn Meter's palette, so the spend looks the same in the box as in its own band. */
export const GOLD = '#c2a87e'
export const ORANGE = '#e8833a'
export const RED = '#e5484d'
export const PAPER = '#e8e2d6'
/** Claude's own mark color, for the ✻ in front of the model. */
export const CLAY = '#d97757'

/** `$12.34`, or four decimals under a cent so the first fractions still move. */
export function money(usd: number): string {
  return '$' + (usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2))
}

const pct = (n: number) => `${Math.round(n)}%`

/** 0..1 how hot the spend is, log-scaled to $100: the fill when there are no plan limits. */
const heat = (usd: number) => Math.max(0, Math.min(1, Math.log10(1 + usd) / 2))

const rgb = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))
const mix = (a: string, b: string, t: number) => {
  const [from, to] = [rgb(a), rgb(b)]
  return '#' + from.map((x, i) => Math.round(x + (to[i]! - x) * t).toString(16).padStart(2, '0')).join('')
}

/** Gold to orange to red along 0..1: the fire's own colors. */
export function flame(h: number): string {
  const t = Math.max(0, Math.min(1, h))
  return t < 0.5 ? mix(GOLD, ORANGE, t * 2) : mix(ORANGE, RED, (t - 0.5) * 2)
}

export type Spend = {
  /** What the odometer shows now (`$2.48`); it rolls toward the real cost. */
  money: string
  isRolling: boolean
  /** 0..1: the five-hour window on a plan, else how hot the spend is. */
  fill: number
  color: string
  /** `5h 30% · wk 12%`, or '' with no plan reading. */
  limits: string
}

/** What the box says about the spend; null while there is nothing yet (no cost, no plan reading). */
export function spendSummary(b: BurnMeterSpend): Spend | null {
  if (b.target <= 0 && b.session < 0 && !b.isDemo) return null
  const fill = b.isDemo || b.session < 0 ? heat(b.shown) : Math.max(0.02, Math.min(1, b.session / 100))
  const color = fill > 0.75 ? RED : fill > 0.45 ? ORANGE : GOLD
  const limits = [b.session >= 0 ? `5h ${pct(b.session)}` : '', b.week >= 0 ? `wk ${pct(b.week)}` : '']
    .filter(part => part !== '')
    .join(' · ')
  return { money: money(b.shown), isRolling: b.shown !== b.target, fill, color, limits }
}

/** A thin meter, `━━━━────`: a color per lit cell, gold to red along the bar. */
export function meterCells(cells: number, fill: number): { lit: string[]; unlit: number } {
  if (cells <= 0) return { lit: [], unlit: 0 }
  const count = fill <= 0 ? 0 : Math.max(1, Math.min(cells, Math.round(fill * cells)))
  const lit = Array.from({ length: count }, (_, i) => flame(cells === 1 ? 1 : i / (cells - 1)))
  return { lit, unlit: cells - count }
}

/** The meter's cells for a box `columns` wide: it is the first thing to go on a narrow terminal. */
export function meterWidth(columns: number): number {
  return columns >= 110 ? 14 : columns >= 90 ? 10 : columns >= 72 ? 6 : 0
}

/** The plan windows for a box `columns` wide: the weekly one goes on a very narrow terminal. */
export function limitsFor(limits: string, columns: number): string {
  return columns >= 56 ? limits : limits.split(' · ')[0] ?? ''
}
