export type AutoModelTier = 'light' | 'standard' | 'heavy'

export type AutoModelDecision = {
  tier: AutoModelTier
  model: string
  effort: 'low' | 'medium' | 'high' | null
  why: 'classified' | 'kept' | 'short-reply' | 'fallback'
}

declare module 'claude-code' {
  interface PluginState {
    'auto-model': {
      isOn: boolean
      last: AutoModelDecision | null
    }
  }
}
