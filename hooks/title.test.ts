import { describe, expect, test, tier } from 'claude-code/testing'
import { TitleScanner, TITLE_LIMIT, transcriptRead } from './title'

tier('user')

const line = (row: object) => `${JSON.stringify(row)}\n`

/** A scanner fed `text` in pieces of `size` characters. */
function scan(text: string, size = text.length) {
  const scanner = new TitleScanner()
  for (let index = 0; index < text.length; index += size) scanner.push(text.slice(index, index + size))
  return scanner
}

describe('session title', () => {
  test('the last rename wins over any title Claude chose; otherwise Claude\'s latest', () => {
    const chosen = line({ type: 'ai-title', aiTitle: 'First guess', sessionId: 's' })
    const later = line({ type: 'ai-title', aiTitle: 'Better guess', sessionId: 's' })
    const renamed = line({ type: 'custom-title', customTitle: 'Mine', sessionId: 's' })
    expect(scan('').title).toBeUndefined()
    expect(scan(chosen + later).title).toBe('Better guess')
    expect(scan(chosen + renamed + later).title).toBe('Mine')
    // Text fed later, as each turn's end reads what the file gained, keeps what came before.
    const scanner = scan(chosen)
    scanner.push(renamed)
    scanner.push(later)
    expect(scanner.title).toBe('Mine')
  })

  test('titles split across pieces are found, and other rows are passed over', () => {
    const user = line({ type: 'user', message: { content: `${'x'.repeat(50_000)} {"type":"ai-title","aiTitle":"Fake"}` } })
    const text = user + line({ type: 'ai-title', aiTitle: 'Real' }) + user
    for (const size of [1, 3, 7, 4096, text.length]) expect(scan(text, size).title).toBe('Real')
    // A row that merely mentions a title type does not open like one.
    expect(scan(line({ type: 'user', note: '{"type":"ai-title","aiTitle":"No"}' })).title).toBeUndefined()
  })

  test('an unfinished last line is not read', () => {
    expect(scan('{"type":"ai-title","aiTitle":"Half"}').title).toBeUndefined()
  })

  test('titles are one bounded line, and blank or malformed rows are skipped', () => {
    expect(scan(line({ type: 'ai-title', aiTitle: '  Fix\nthe\tparser  ' })).title).toBe('Fix the parser')
    expect(scan(line({ type: 'ai-title', aiTitle: 'Kept' }) + line({ type: 'ai-title', aiTitle: '   ' }) + '{"type":"ai-title",oops\n').title).toBe('Kept')
    const long = scan(line({ type: 'ai-title', aiTitle: 'x'.repeat(500) })).title!
    expect(long).toHaveLength(TITLE_LIMIT)
    expect(long.endsWith('…')).toBe(true)
  })

  test('a transcript is read from an offset with tail, or on Windows with PowerShell given the path as data', () => {
    const path = 'C:\\Users\\a\\.claude\\projects\\x\\s.jsonl"; Remove-Item *'
    expect(transcriptRead('/a/s.jsonl', 1024, false)).toEqual({ argv: ['tail', '-c', '+1025', '/a/s.jsonl'] })
    const windows = transcriptRead(path, 1024, true)
    expect(windows.argv[0]).toBe('powershell.exe')
    expect(windows.argv.join(' ')).not.toContain('s.jsonl')
    expect(JSON.parse(windows.input!)).toEqual({ path, offset: 1024 })
  })
})
