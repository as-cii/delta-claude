type Execution = { sequence: number; turnId?: string; lost?: true; endSequence?: number }
type SavedBinding = {
  next: number
  lastTurnSequence?: number
  lastClaim?: number
  execution?: Execution & { claim?: number }
}

/** Normalize legacy turn identities without mutating persisted data or allocating new sequences. */
export function restoreBinding<T extends SavedBinding>(previous: T) {
  const { lastClaim, execution, ...binding } = structuredClone(previous)
  const validSequence = (sequence: unknown): sequence is number =>
    Number.isSafeInteger(sequence) && Number(sequence) > 0 && Number(sequence) < binding.next
  const lastTurnSequence = binding.lastTurnSequence ?? lastClaim
  if (lastTurnSequence !== undefined && !validSequence(lastTurnSequence))
    throw new Error('Invalid saved turn sequence; preserve the outbox and producer state')
  let restored: Execution | undefined
  if (execution) {
    const sequence = execution.sequence ?? execution.claim
    if (!validSequence(sequence) ||
        (execution.turnId !== undefined && (typeof execution.turnId !== 'string' || !execution.turnId)) ||
        (execution.endSequence !== undefined && (!validSequence(execution.endSequence) || execution.endSequence <= sequence)))
      throw new Error('Invalid saved execution; preserve the outbox and producer state')
    restored = { sequence, turnId: execution.turnId, lost: execution.lost, endSequence: execution.endSequence }
  }
  return { ...binding, lastTurnSequence, execution: restored }
}
