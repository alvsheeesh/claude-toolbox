import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ToolboxMod, ToolboxModel } from '../types'
import { CLAY, PAPER, autoReason, displayName, limitsFor, meterCells, meterWidth, readMods, spendSummary, stepsLine } from './logic'

type $ = EngineInterface

// The pane earlier versions drew; one left open survives a reload, so it is closed.
const OLD_PANE = 'toolbox'
const COMMAND = 'toolbox'

const modsAtom = atom({ plugin: 'toolbox', key: 'mods' } as const, [])
const modelAtom = atom({ plugin: 'toolbox', key: 'model' } as const, null)
const busyAtom = atom({ plugin: 'toolbox', key: 'busy' } as const, null)
const errorAtom = atom({ plugin: 'toolbox', key: 'error' } as const, null)
// True while the box shows: Clean View then leaves its steps to it.
const hostingAtom = atom({ plugin: 'toolbox', key: 'hosting' } as const, true)
// Clean View's own values, read to draw its steps here; it alone writes them.
const stepsAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const cleanViewOnAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
// Burn Meter's spend, drawn here while the box shows; it alone writes it.
const burnAtom = atom({ plugin: 'burn-meter', key: 'burn' } as const, null)
const expandedAtom = atom({ plugin: 'toolbox', key: 'expanded' } as const, false)
// Where the dock sits: under the prompt (the default) or above it; kept across sessions in $.store.
const placementAtom = atom({ plugin: 'toolbox', key: 'placement' } as const, 'bottom')
const PLACEMENT_KEY = 'placement'
// Cells the prompt footer keeps clear at its sides.
const FOOTER_MARGIN = 4

type Placement = 'top' | 'bottom'
// The drawing surface's elements, as `$.ui.resolve(e)` hands them to either site.
type Elements = { Box: any; Text: any; Button: any }

// What auto-model picked for the turn running now, seen as it writes its own state.
let autoThisTurn: { tier: string; why: string; effort: string | null } | null = null

async function listMods($: $) {
  const { exitCode, stdout, stderr } = await $.process.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 20_000 })
  if (exitCode !== 0) throw new Error(stderr.trim() || `claude plugin list exited ${exitCode}`)
  return stdout
}

async function refreshMods($: $, isSessionLoad: boolean) {
  const json = await listMods($)
  const current = await read($, modsAtom)
  // On a (re)load, what settings say now is what this session runs; later, keep what it loaded.
  const loaded = new Map(isSessionLoad ? [] : current.map(m => [m.id, m.wasEnabled] as const))
  const mods = readMods(json, loaded)
  await update($, modsAtom, () => mods)
}

/** Clean View's steps while it is loaded and on; a read of a plugin not loaded is refused. */
async function cleanViewSteps($: $) {
  try {
    return (await read($, cleanViewOnAtom)) ? await read($, stepsAtom) : null
  } catch {
    return null
  }
}

/** Burn Meter's spend while it is loaded; a read of a plugin not loaded is refused. */
async function burnSpend($: $) {
  try {
    const burn = await read($, burnAtom)
    return burn === null ? null : spendSummary(burn)
  } catch {
    return null
  }
}

/** Before the first reply, the model and effort the session is set to, as the banner shows them. */
async function seedModel($: $) {
  if ((await read($, modelAtom)) !== null) return
  const model = await $.session.model()
  const rows = await $.config.list().catch(() => [])
  const effort = rows.find(row => /effort/i.test(row.key) && typeof row.value === 'string')
  const seeded: ToolboxModel = { model, effort: effort ? String(effort.value) : null, auto: null }
  await update($, modelAtom, current => current ?? seeded)
}

async function toggle($: $, mod: ToolboxMod) {
  if ((await read($, busyAtom)) !== null) return
  await update($, busyAtom, () => mod.id)
  await update($, errorAtom, () => null)
  try {
    const verb = mod.isEnabled ? 'disable' : 'enable'
    const { exitCode, stderr } = await $.process.run(['claude', 'plugin', verb, mod.id, '--scope', 'user'], {
      timeoutMs: 30_000,
    })
    if (exitCode !== 0) throw new Error(stderr.trim() || `claude plugin ${verb} exited ${exitCode}`)
    await refreshMods($, false)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, errorAtom, () => `${mod.name}: ${message.split('\n')[0]}`)
  } finally {
    await update($, busyAtom, () => null)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'The Toolbox dock (model, effort, spend, steps, mod switches): /toolbox shows it, off hides it, top or bottom moves it, mods opens the switches',
      argumentHint: 'off | top | bottom | mods',
    })
    void $.store
      .get(PLACEMENT_KEY)
      .then(saved => (saved === 'top' || saved === 'bottom' ? update($, placementAtom, () => saved) : undefined))
      .catch(() => undefined)
    void $.ui.close({ id: OLD_PANE }).catch(() => undefined)
    void update($, hostingAtom, () => true)
    void seedModel($).catch(() => undefined)
    void refreshMods($, true).catch(err => update($, errorAtom, () => String(err).split('\n')[0]))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await update($, hostingAtom, () => false)
      return { text: 'Toolbox hidden. /toolbox shows it again.' }
    }
    await update($, hostingAtom, () => true)
    if (arg === 'mods') {
      await update($, expandedAtom, open => !open)
      const isOpen = await read($, expandedAtom)
      return { text: isOpen ? 'Toolbox switches open. /toolbox mods folds them.' : 'Toolbox switches folded.' }
    }
    if (arg === 'top' || arg === 'bottom') {
      await update($, placementAtom, () => arg)
      await $.store.set(PLACEMENT_KEY, arg).catch(() => undefined)
    }
    await refreshMods($, false).catch(err => update($, errorAtom, () => String(err).split('\n')[0]))
    const where = (await read($, placementAtom)) === 'top' ? 'above' : 'under'
    return { text: `Toolbox shown ${where} the prompt.` }
  }).catch(() => ({ text: 'The Toolbox hit a problem.' }))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) autoThisTurn = null
    return next(e)
  })

  // auto-model writes its pick before the turn's first request; reading the write tells why.
  on('state.set', { plugin: 'auto-model', key: 'last' } as never, ($, e, next) => {
    const value = (e as { value?: unknown }).value as { tier?: string; why?: string; effort?: string | null } | null
    if (value && typeof value.tier === 'string') {
      autoThisTurn = { tier: value.tier, why: value.why ?? 'classified', effort: value.effort ?? null }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage !== null) {
      const auto = autoThisTurn
      const effort = auto !== null ? auto.effort : typeof e.effort === 'string' ? e.effort : null
      const model: ToolboxModel = {
        model: result.usage.model,
        effort,
        auto: auto === null ? null : { tier: auto.tier, why: auto.why },
      }
      await update($, modelAtom, () => model)
    }
    return result
  })

  // The dock above the prompt (`/toolbox top`): Clean View and Burn Meter leave the band to it
  // while it shows; whatever another mod draws there still goes under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await isShown($, 'top'))) return next(e)
    const elements = $.ui.resolve(e)
    const dock = await drawDock($, elements, Math.max(30, e.props.bodyColumns))
    const below = await next(e)
    const { Box } = elements
    return (
      <Box flexDirection="column">
        {dock}
        {below}
      </Box>
    )
  })

  // The dock under the prompt (the default): the engine's hint line (`? for shortcuts`, the
  // mode pills) stays where it is, and the dock goes under it, at the bottom of the screen.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!(await isShown($, 'bottom'))) return next(e)
    const elements = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 80
    const dock = await drawDock($, elements, Math.max(30, columns - FOOTER_MARGIN))
    const line = await next(e)
    const { Box } = elements
    return (
      <Box flexDirection="column">
        {line}
        {dock}
      </Box>
    )
  })
}

/** True while the dock shows and sits at `where`. */
async function isShown($: $, where: Placement) {
  return (await read($, hostingAtom)) && (await read($, placementAtom)) === where
}

/**
 * The dock: the model, the spend and (opened from `mods`) the switches on top, Clean View's
 * steps under them, `width` cells across.
 *
 * No Button here takes a digit hotkey: a bare digit typed into an empty prompt presses a band
 * Button with that hotkey, so a message starting with "4" would switch a mod off.
 */
async function drawDock($: $, { Box, Text, Button }: Elements, width: number) {
  const model = await read($, modelAtom)
  const mods = await read($, modsAtom)
  const busy = await read($, busyAtom)
  const error = await read($, errorAtom)
  const isExpanded = await read($, expandedAtom)
  const steps = await cleanViewSteps($)
  const spend = await burnSpend($)
  const progress = steps === null ? null : stepsLine(steps)
  const needsReload = mods.some(m => m.isEnabled !== m.wasEnabled)
  const meter = spend === null ? null : meterCells(meterWidth(width), spend.fill)
  const limits = spend === null ? '' : limitsFor(spend.limits, width)

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexShrink={1}>
          <Text wrap="truncate">
            <Text color={CLAY}>✻ </Text>
            {model === null ? (
              <Text dimColor>no reply yet</Text>
            ) : (
              <Text>
                <Text bold>{displayName(model.model)}</Text>
                <Text dimColor>
                  {model.effort !== null ? ` · ${model.effort}` : ''}
                  {model.auto !== null ? ` · auto, ${autoReason(model.auto.tier, model.auto.why)}` : ''}
                </Text>
              </Text>
            )}
          </Text>
        </Box>
        <Box flexDirection="row" flexShrink={0} gap={2}>
          {spend === null || meter === null ? null : (
            <Text>
              <Text bold color={spend.isRolling ? spend.color : PAPER}>
                {spend.money}
              </Text>
              {meter.lit.length + meter.unlit > 0 ? ' ' : ''}
              {meter.lit.map(color => (
                <Text color={color}>━</Text>
              ))}
              <Text dimColor>{'─'.repeat(meter.unlit)}</Text>
              {limits !== '' ? <Text dimColor>{` ${limits}`}</Text> : ''}
            </Text>
          )}
          <Button key="toolbox-mods" plain onPress={() => update($, expandedAtom, open => !open)}>
            <Text dimColor={!needsReload} color={needsReload ? 'yellow' : undefined}>
              {`mods${needsReload ? '*' : ''} ${isExpanded ? '▴' : '▾'}`}
            </Text>
          </Button>
        </Box>
      </Box>
      {progress === null ? null : (
        <Text wrap="truncate">
          <Text color={progress.color}>{progress.marks}</Text>
          {'  '}
          <Text color={progress.isAlert ? progress.color : undefined}>{progress.title}</Text>
          <Text dimColor>{` · ${progress.detail}`}</Text>
        </Text>
      )}
      {!isExpanded ? null : (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {mods.map(mod => (
            <Button key={mod.id} plain onPress={() => toggle($, mod)}>
              <Text color={mod.isEnabled ? 'green' : undefined} dimColor={!mod.isEnabled}>
                {mod.isEnabled ? '●' : '○'}
              </Text>
              <Text dimColor={!mod.isEnabled}>{` ${mod.name}`}</Text>
              <Text color="yellow">{busy === mod.id ? ' …' : mod.isEnabled !== mod.wasEnabled ? ' *' : ''}</Text>
            </Button>
          ))}
          {needsReload ? <Text color="yellow" dimColor>* after /reload-plugins</Text> : null}
        </Box>
      )}
      {error === null ? null : (
        <Text wrap="truncate" color="red">
          {error}
        </Text>
      )}
    </Box>
  )
}
