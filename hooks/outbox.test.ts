import { describe, expect, test, tier } from 'claude-code/testing'
import { acknowledgedOutboxFiles, acknowledgedPrefix, appendOutboxRecord, outboxRemoval } from './outbox'
import { cliFixture } from './cli-fixtures'

tier('user')

describe('outbox', () => {
  test('acknowledgments match only the exact thread, sequence, and turn association', () => {
    const receipt = (patch = {}) => JSON.stringify(cliFixture('recorded', patch))
    const thread = cliFixture('recorded').thread_id
    const records = [{ sequence: 1, turnSequence: 1 }, { sequence: 2, turnSequence: 1 }]
    const first = receipt({ turn_sequence: 1 })
    const second = receipt({ sequence: 2, next_sequence: 3, turn_sequence: 1 })
    expect(acknowledgedPrefix(`${first}\n${second}`, thread, records).count).toBe(2)
    expect(acknowledgedPrefix(first, thread, records).count).toBe(1)
    for (const patch of [{ thread_id: 'other-thread' }, { turn_sequence: undefined },
      { turn_sequence: null }, { operation: 'turn_ended' }]) {
      expect(acknowledgedPrefix(receipt(patch), thread, records).count).toBe(0)
      expect(acknowledgedPrefix(`${first}\n${receipt({ sequence: 2, next_sequence: 3, ...patch })}`,
        thread, records).count).toBe(1)
    }
    expect(acknowledgedPrefix(receipt(), thread, [{ sequence: 1 }]).count).toBe(1)
    expect(acknowledgedPrefix(receipt({ next_sequence: 8, duplicate: true, disposition: 'duplicate' }),
      thread, [{ sequence: 1 }]).count).toBe(1)
  })

  test('fenced receipts report the turn they were refused for', () => {
    const thread = cliFixture('fenced').thread_id
    const records = [{ sequence: 1, turnSequence: 1 }, { sequence: 2, turnSequence: 1 }]
    const first = JSON.stringify(cliFixture('fenced', { sequence: 1, next_sequence: 2, turn_sequence: 1 }))
    const second = JSON.stringify(cliFixture('fenced'))
    expect(acknowledgedPrefix(`${first}\n${second}`, thread, records)).toEqual({ count: 2, fenced: [1, 1] })
    expect(acknowledgedPrefix(first, thread, records)).toEqual({ count: 1, fenced: [1] })
    // A recorded receipt reports no fenced turn.
    expect(acknowledgedPrefix(JSON.stringify(cliFixture('recorded', { turn_sequence: 1 })),
      thread, [{ sequence: 1, turnSequence: 1 }])).toEqual({ count: 1, fenced: [] })
  })

  test('legacy associated state remains historical; explicit controls and content retain their sequences', () => {
    const translated = (record: Record<string, unknown>) =>
      JSON.parse(appendOutboxRecord(JSON.stringify(record) + '\n', record.sequence as number).line)
    expect(translated({ schemaVersion: 1, sequence: 1, turn: { action: 'claim' } })).toEqual({
      schemaVersion: 1, sequence: 1, turnSequence: 1, update: { sessionUpdate: 'state_update', state: 'running' },
    })
    for (const state of ['running', 'idle']) {
      const update = { sessionUpdate: 'state_update', state }
      expect(translated({ schemaVersion: 1, sequence: 2, claim: 1, update })).toEqual({ schemaVersion: 1, sequence: 2, update })
      const ordinary = { schemaVersion: 1, sequence: 2, update }
      expect(translated(ordinary)).toEqual(ordinary)
    }
    const update = { sessionUpdate: 'agent_message', content: [{ type: 'text', text: 'still running' }] }
    expect(translated({ schemaVersion: 1, sequence: 4, claim: 1, update })).toEqual({
      schemaVersion: 1, sequence: 4, turnSequence: 1, update,
    })
  })

  test('malformed saved controls fail closed without changing their immutable representation', () => {
    for (const patch of [
      { schemaVersion: 2 }, { sequence: 9 }, { update: { sessionUpdate: 'state_update', state: 'idle' } },
      { claim: 1 }, { turn: { action: 'claim', claim: 1 } }, { turn: { action: 'unknown' } },
      { turn: { action: 'end', claim: 0 } }, { turn: { action: 'end', claim: 1 } },
      '{"schemaVersion":1,"sequence":1,"turn":{"action":"end","action":"claim"}}',
      '{"schemaVersion":1,"sequence":99,"sequence":1,"turn":{"action":"claim"}}',
    ]) {
      const line = (typeof patch === 'string' ? patch : JSON.stringify({ schemaVersion: 1, sequence: 1, turn: { action: 'claim' }, ...patch })) + '\n'
      expect(() => appendOutboxRecord(line, 1)).toThrow()
    }
  })

  test('deletes only known record filenames below the durable pending frontier', () => {
    const entries = ['1-0.json', '1-1.json', '2-0.json', '3-0.json', 'notes.json', '../1-0.json', '0-0.json']
      .map((name) => ({ name, kind: 'file', isLink: false }))
    entries.push({ name: '1-2.json', kind: 'other', isLink: true })
    entries.push({ name: '1-3.json', kind: 'directory', isLink: false })
    expect(acknowledgedOutboxFiles('/outbox/session', 3,
      [{ sequence: 2, files: ['/outbox/session/2-0.json'] }], entries))
      .toEqual(['/outbox/session/1-0.json', '/outbox/session/1-1.json'])
    expect(acknowledgedOutboxFiles('/outbox/session', 3, [], entries))
      .toEqual(['/outbox/session/1-0.json', '/outbox/session/1-1.json', '/outbox/session/2-0.json'])
    expect(acknowledgedOutboxFiles('/outbox/session', 1, [], entries)).toEqual([])
  })

  test('corrupt frontiers fail closed and referenced paths are never collected', () => {
    const entries = [{ name: '1-0.json', kind: 'file', isLink: false }]
    for (const next of [0, NaN, 1.5])
      expect(() => acknowledgedOutboxFiles('/outbox/session', next, [], entries)).toThrow()
    expect(() => acknowledgedOutboxFiles('/outbox/session', 3, [{ sequence: 3, files: [] }], entries)).toThrow()
    expect(acknowledgedOutboxFiles('/outbox/session', 3,
      [{ sequence: 2, files: ['/outbox/session/1-0.json'] }], entries)).toEqual([])
  })

  test('platform removal passes paths as data, never shell source', () => {
    const files = ['/outbox/a b/1-0.json', '/outbox/"$(echo nope)"/2-0.json']
    expect(outboxRemoval(files, false)).toEqual({ argv: ['rm', '-f', '--', ...files] })
    const windows = outboxRemoval(files, true)
    expect(windows.argv[0]).toBe('powershell.exe')
    expect(windows.argv.join(' ')).not.toContain(files[1]!)
    expect(JSON.parse(windows.stdin!)).toEqual(files)
  })
})
