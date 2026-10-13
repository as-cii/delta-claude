import { isThoughtItem } from './conversation'
import type { WatchItem } from './thread-commands'

type DrawResult = { deny?: string }
type DrawTimer = { cancel(): void }
export type PendingDraw = { session: string; id: string; settle(result: DrawResult): void }

/** Thinking is announced once on live completion and never becomes a model row. */
export function announceThought(before: WatchItem | undefined, item: WatchItem, snapshotDone: boolean): boolean {
  return isThoughtItem(item) && !item.open && snapshotDone && (!before || before.open)
}

/** A successful person-visible draw is remembered even if its model row must retry. */
export class DrawnRows {
  private items = new Set<string>()

  drawOnce(id: string, draw: () => Promise<DrawResult>): Promise<DrawResult> | undefined {
    if (this.items.has(id)) return
    return draw().then((result) => {
      if (result.deny === undefined) this.items.add(id)
      return result
    })
  }
}

/** Queue rows until a hook can draw them, retaining order across held turns. */
export class DrawQueue {
  private pending: PendingDraw[] = []
  get length() { return this.pending.length }
  shift() { return this.pending.shift() }

  wait(session: string, id: string, held: () => boolean,
    after: (milliseconds: number, action: () => void) => DrawTimer): Promise<DrawResult> {
    return new Promise((resolve) => {
      let added = false
      let timer: DrawTimer | undefined
      const entry: PendingDraw = { session, id, settle: (result) => {
        if (added) return
        added = true
        timer?.cancel()
        resolve(result)
      } }
      const arm = () => {
        timer = after(2000, () => {
          if (held()) arm()
          else {
            this.pending = this.pending.filter((queued) => queued !== entry)
            entry.settle({ deny: 'the transcript drew no command output row' })
          }
        })
      }
      arm()
      this.pending.push(entry)
    })
  }

  drop() {
    const queued = this.pending
    this.pending = []
    for (const entry of queued) entry.settle({ deny: 'the Delta watcher stopped before the row was drawn' })
  }
}

export const SHOW_ANSWER = '.'
const SHOW_OUTPUT_ROW = `<local-command-stdout>${SHOW_ANSWER}</local-command-stdout>`

/** Identify the item in an internal command without interpreting its content. */
export function shownItemId(args: string): string | undefined {
  return /^show\s+(\S+)$/.exec(args.trim())?.[1]
}

/** Rewrite only this plugin's hidden command echo and output, not unrelated command rows. */
export function shownCommandRewrite(plugin: string, row: {
  door: string
  origin?: unknown
  message: { type: string; name?: string; role?: string; content: readonly { type: string; text?: string }[] }
}): { type: 'text'; text: string }[] | undefined {
  if (row.door !== 'command') return
  const text = row.message.content.flatMap((block) =>
    block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
  const origin = row.origin as { kind?: string; name?: string } | undefined
  if (row.message.role === 'user' && origin?.kind === 'plugin' && origin.name === plugin &&
      /<command-name>[^<]*<\/command-name>/.test(text) && /<command-args>show\s+\S+<\/command-args>/.test(text))
    return []
  if (row.message.type === 'system' && row.message.name === 'local_command' &&
      (text === `<local-command-stdout>${plugin}: ${SHOW_ANSWER}</local-command-stdout>` || text === SHOW_OUTPUT_ROW))
    return [{ type: 'text', text: SHOW_OUTPUT_ROW }]
}
