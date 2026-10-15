import { expect, test } from 'claude-code/testing'
import { cliErrorCodes, cliFixture, cliFixtures, cliWatchFrames } from './cli-fixtures'
import { cliFixtureData } from './cli-fixture-data'
import {
  DeltaCommandError, classifyCommandFailure, commandErrorFromEnvelope, parseAppendReceipt, parseThreadMount,
  parseThreadStatus, parseWatchEvent,
} from './thread-commands'

test('documented status, mount, append receipts, and watch frames parse at the CLI boundary', () => {
  for (const name of ['thread-status.local_only', 'thread-status.granted', 'thread-status.worktrees_unavailable'])
    expect(parseThreadStatus(JSON.stringify(cliFixtureData[name])).worktrees.status).toBe(cliFixtureData[name].worktrees.status)
  expect(parseThreadStatus(JSON.stringify(cliFixtures.status)).thread_id).toBe(cliFixtures.status.thread_id)
  expect(parseThreadMount(JSON.stringify(cliFixtures.mount), cliFixtures.mount.owner).worktrees).toHaveLength(1)
  for (const name of ['recorded', 'fenced', 'duplicate'] as const) {
    const receipt = cliFixtures[name]
    expect(parseAppendReceipt(JSON.stringify(receipt), receipt.thread_id, receipt.sequence).disposition).toBe(name)
  }
  for (const frame of cliWatchFrames)
    expect(parseWatchEvent(JSON.stringify(frame))?.type).toBe(frame.type ?? 'error')
  const error = parseWatchEvent(JSON.stringify(cliFixtures.error))
  expect(error?.type).toBe('error')
  if (error?.type === 'error') expect(error.error.code).toBe('watch_reset')
  const patched = cliFixture('status', { thread_id: 'other' })
  expect(patched.thread_id).toBe('other')
  expect(cliFixtures.status.thread_id).not.toBe('other')
})

test('every published code is decided by its envelope, and pinned retryability agrees', () => {
  for (const [code, hints] of Object.entries(cliErrorCodes)) {
    const parsed = commandErrorFromEnvelope({ code, message: 'example', ...hints })
    expect(parsed?.code).toBe(code)
    expect(parsed?.hints.retryable).toBe(hints.retryable)
    if (hints.retry_after_ms !== undefined) expect(parsed?.hints.retryAfterMs).toBe(hints.retry_after_ms)
    // Where every cause agrees, the pinned class says how the CLI will classify this code.
    if (hints.retryable !== undefined) expect(classifyCommandFailure(parsed!)).toBe(hints.retryable ? 'transient' : 'permanent')
    // Codes whose retryability varies (`{}`) still follow whatever the envelope carries.
    for (const retryable of [true, false])
      expect(classifyCommandFailure(new DeltaCommandError(code, 'example', { retryable }))).toBe(retryable ? 'transient' : 'permanent')
  }
})
