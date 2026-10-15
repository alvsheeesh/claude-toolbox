export type ToolboxMod = {
  /** The plugin id, `clean-view@claude-toolbox`. */
  id: string
  /** What the panel calls it, `Clean View`. */
  name: string
  /** Enabled in settings now (what the next /reload-plugins loads). */
  isEnabled: boolean
  /** Enabled when this session loaded its plugins. */
  wasEnabled: boolean
}

export type ToolboxModel = {
  /** The id the API reported for the last main-thread reply. */
  model: string
  effort: string | null
  /** Set when auto-model picked the model for that turn. */
  auto: { tier: string; why: string } | null
}

/** Clean View's steps, as its own contract has them (the fields the panel draws). */
export type CleanViewStep = {
  id: string
  name: string
  status: 'done' | 'active' | 'upcoming'
  percent: number
  hasReported: boolean
}

export type CleanViewSteps = {
  title: string
  phase: 'working' | 'needs-you' | 'stuck' | 'stopped' | 'done'
  tasks: CleanViewStep[]
  needsYouReason: string | null
  stuckReason: string | null
  /** A finished job folds away a few seconds after it ends. */
  isCollapsed: boolean
}

/** Burn Meter's spend, as its own contract has it (the fields the box draws). */
export type BurnMeterSpend = {
  /** What its odometer shows now; it tweens toward `target`. */
  shown: number
  /** The session's real cost, or the demo ramp while a demo runs. */
  target: number
  isDemo: boolean
  /** Plan windows, 0..100, or -1 with no reading (an API key, or before the first reply). */
  session: number
  week: number
}

declare module 'claude-code' {
  interface PluginState {
    toolbox: {
      mods: ToolboxMod[]
      model: ToolboxModel | null
      busy: string | null
      hosting: boolean
      /** True while the mod switches row is open. */
      expanded: boolean
      /** Where the dock sits: under the prompt (default) or above it. */
      placement: 'top' | 'bottom'
      error: string | null
    }
    'clean-view': {
      checklist: CleanViewSteps | null
      cleanViewEnabled: boolean
    }
    'burn-meter': {
      burn: BurnMeterSpend
    }
  }
}
