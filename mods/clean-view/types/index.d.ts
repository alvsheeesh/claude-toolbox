export type CleanViewPhase = 'working' | 'needs-you' | 'stuck' | 'stopped' | 'done'

export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  percent: number
  hasReported: boolean
}

export type CleanViewChecklist = {
  /** The turn id that started the job; a late job name for an older job is dropped. */
  jobId: string
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  /** True once Claude laid out a real plan (plan_steps, TodoWrite or TaskCreate). */
  hasPlan: boolean
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  isCollapsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist | null
      tick: number
    }
  }
}
