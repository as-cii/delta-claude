import type { MountedThread, ThreadMount, ThreadState } from './thread-commands'

/** Clearing and resuming switch sessions; only exiting releases their mounts. */
export function releasesMounts(reason: string): boolean {
  return ['prompt_input_exit', 'logout', 'other'].includes(reason)
}

/** Join requires a host that can interactively transition sessions. */
export function interactiveJoin(surfaces: readonly string[]): boolean {
  return surfaces.some((surface) => surface === 'terminal' || surface === 'desktop')
}

/** Return missing built-ins, never treating a plugin command as a host capability. */
export function missingJoinCommands(names: readonly string[], commands: readonly { name: string; source: string }[]): string[] {
  return names.filter((name) => !commands.some((entry) => entry.name === name && entry.source === 'builtin'))
}

/** Refuse inaccessible or empty threads before clearing the existing session. */
export function joinPreflight(status: ThreadState): 'access' | 'empty' | undefined {
  if (status.access.state !== 'granted') return 'access'
  if (status.worktrees.status === 'available' && !status.worktrees.items.length) return 'empty'
}

/** Compute changed worktrees and whether the checkout-to-folder transition is needed. */
export function worktreeChanges(previous: readonly ThreadMount[], directory: string | undefined, mounted: MountedThread) {
  return {
    added: mounted.worktrees.filter((tree) => !previous.some((mount) => mount.reference === tree.reference)),
    removed: previous.filter((mount) => !mounted.worktrees.some((tree) => tree.reference === mount.reference)),
    moves: previous.some((mount) => mount.directory === directory) && mounted.directory !== directory,
  }
}

/** A confirmation cannot proceed while any background agent is still active. */
export function activeBackgroundAgents(agents: readonly { status: string }[]): boolean {
  return agents.some((agent) => !['completed', 'failed', 'killed'].includes(agent.status))
}

/** Hold prompts during an incomplete join, restoration, or between-turn directory move. */
export function promptGate(state: {
  joining?: boolean; sharing?: boolean; transition?: boolean; snapshot?: boolean
  restoring?: boolean; movePending?: boolean; steering?: boolean
}): 'joining' | 'sharing' | 'transition' | 'restoring' | 'moving' | undefined {
  if (state.joining) return 'joining'
  if (state.sharing) return 'sharing'
  if (state.transition) return 'transition'
  if (!state.snapshot) return
  if (state.restoring) return 'restoring'
  if (state.movePending && !state.steering) return 'moving'
}

/** Steering belongs only to the exact live local execution. */
export function ownsSteering(
  execution: { turnId?: string; lost?: true; endSequence?: number } | undefined, turnId: string,
): boolean {
  return !!execution && execution.turnId === turnId && !execution.lost && !execution.endSequence
}
