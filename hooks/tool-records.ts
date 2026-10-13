import type { ApiContentBlock } from 'claude-code'
import type { Update } from './content'

/**
 * Per-session tool data that links a call hook's structured result to the result row Claude stores.
 *
 * The two arrive in either order and each needs the other's data, so an entry is kept until both
 * have been recorded. `forgetUnpaired` bounds tools whose other half never comes, such as a refused
 * call that has no hook or an interrupted one that has no row, one turn after they were made.
 */
export class ToolRecords {
  /** Full structured outputs from call hooks, by tool use ID. */
  readonly structuredResults = new Map<string, Update>()
  /** Result rows Claude stored, by tool use ID. */
  readonly toolResults = new Map<string, ApiContentBlock>()
  /** The turn sequence captured when the tool was called. */
  readonly toolTurns = new Map<string, number | undefined>()
  /** Calls left out of Delta's transcript, so their result rows are left out too. */
  readonly omitted = new Set<string>()
  private readonly settled = new Map<string, 'call' | 'row'>()

  /** Entries currently retained across all maps. */
  get size(): number {
    return this.structuredResults.size + this.toolResults.size + this.toolTurns.size + this.omitted.size +
      this.settled.size
  }

  /** Record that the call hook or the result row finished; the second half releases the entry. */
  settle(id: string, half: 'call' | 'row'): void {
    if (this.settled.get(id) === (half === 'call' ? 'row' : 'call')) this.forget(id)
    else this.settled.set(id, half)
  }

  forget(id: string): void {
    this.structuredResults.delete(id)
    this.toolResults.delete(id)
    this.toolTurns.delete(id)
    this.omitted.delete(id)
    this.settled.delete(id)
  }

  /**
   * Release unpaired entries from turns before the one that just completed, and any with no turn.
   * The completed turn's own entries stay, so a row that arrives late still finds its turn and output;
   * they go when the next turn completes. A tool still running has no settled half and is never released.
   */
  forgetUnpaired(completedSequence: number): void {
    for (const id of [...this.settled.keys()]) {
      const turn = this.toolTurns.get(id)
      if (turn === undefined || turn < completedSequence) this.forget(id)
    }
  }

  clear(): void {
    this.structuredResults.clear()
    this.toolResults.clear()
    this.toolTurns.clear()
    this.omitted.clear()
    this.settled.clear()
  }
}
