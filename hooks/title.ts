import { conversationText } from './conversation'

/** A thread title keeps at most this much. */
export const TITLE_LIMIT = 200

/**
 * Claude writes each title as one compact JSON row that opens this way: `ai-title` for the title it
 * chose, `custom-title` for a person's `/rename`.
 */
const TITLE_OPENINGS = ['{"type":"ai-title"', '{"type":"custom-title"']

/** A title row is short; a longer line is not one, so it is skipped rather than held. */
const TITLE_LINE_LIMIT = 16 * 1024

/**
 * Finds the session's title in transcript text fed to it in pieces, in file order. Only a line that
 * opens like a title row is held until its end, so a large row costs nothing to pass over. The last
 * rename wins over any title Claude chose, before or after it, as in Claude's own session lists.
 * A line still unfinished when the text ends is not read.
 */
export class TitleScanner {
  private chosen?: string
  private renamed?: string
  /** The current line so far, while it may still be a title row. */
  private line = ''
  private skipping = false

  get title(): string | undefined { return this.renamed ?? this.chosen }

  push(text: string) {
    let start = 0
    while (start < text.length) {
      const end = text.indexOf('\n', start)
      if (!this.skipping) {
        this.line += text.slice(start, end < 0 ? text.length : end)
        const opening = this.line.slice(0, Math.max(...TITLE_OPENINGS.map((value) => value.length)))
        if (this.line.length > TITLE_LINE_LIMIT ||
            !TITLE_OPENINGS.some((value) => value.startsWith(opening) || opening.startsWith(value))) {
          this.line = ''
          this.skipping = true
        }
      }
      if (end < 0) return
      if (!this.skipping) this.read(this.line)
      this.line = ''
      this.skipping = false
      start = end + 1
    }
  }

  private read(line: string) {
    let row: any
    try { row = JSON.parse(line) } catch { return }
    if (row?.type === 'ai-title' && typeof row.aiTitle === 'string') this.chosen = cleanTitle(row.aiTitle) ?? this.chosen
    else if (row?.type === 'custom-title' && typeof row.customTitle === 'string') this.renamed = cleanTitle(row.customTitle) ?? this.renamed
  }
}

/**
 * The command that prints a file from byte `offset` to its end, without reading what comes before:
 * `tail` on POSIX, and on Windows PowerShell seeking a stream it opens alongside Claude's own writer.
 * The path and offset reach PowerShell as JSON on stdin, never as command text.
 */
export function transcriptRead(path: string, offset: number, windows: boolean): { argv: string[]; input?: string } {
  if (!windows) return { argv: ['tail', '-c', `+${offset + 1}`, path] }
  return {
    argv: ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::InputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ' +
      '$read = ConvertFrom-Json ([Console]::In.ReadToEnd()); ' +
      '$file = [IO.File]::Open($read.path, "Open", "Read", "ReadWrite, Delete"); ' +
      'try { [void]$file.Seek([long]$read.offset, "Begin"); $out = [Console]::OpenStandardOutput(); ' +
      '$file.CopyTo($out); $out.Flush() } finally { $file.Dispose() }'],
    input: JSON.stringify({ path, offset }),
  }
}

/** One line of at most {@link TITLE_LIMIT} characters, or undefined when nothing is left. */
function cleanTitle(title: string): string | undefined {
  const line = conversationText(title).replace(/\s+/g, ' ').trim()
  if (!line) return
  if (line.length <= TITLE_LIMIT) return line
  const end = /[\uD800-\uDBFF]/.test(line.charAt(TITLE_LIMIT - 2)) ? TITLE_LIMIT - 2 : TITLE_LIMIT - 1
  return `${line.slice(0, end)}…`
}
