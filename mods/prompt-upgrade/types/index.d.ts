export type PromptUpgradeStep = 'compose' | 'reading' | 'questions' | 'rewriting' | 'review' | 'error' | 'history'

export type PromptUpgradeQuestion = { question: string; options: string[] }

/** One answer: the option picked or typed, or null when skipped. Absent while open. */
export type PromptUpgradeAnswer = { value: string | null }

export type PromptUpgradeResult = {
  id: string
  at: number
  original: string
  upgraded: string
  added: string[]
}

export type PromptUpgradeFlow = {
  id: string
  step: PromptUpgradeStep
  original: string
  questions: PromptUpgradeQuestion[]
  answers: (PromptUpgradeAnswer | null)[]
  otherFor: number | null
  upgraded: string
  added: string[]
  isEditing: boolean
  isCopied: boolean
  error: { stage: 'questions' | 'rewrite'; reason: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      flow: PromptUpgradeFlow | null
      auto: boolean
      history: PromptUpgradeResult[]
    }
  }
}
