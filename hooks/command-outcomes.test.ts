import { expect, test } from 'claude-code/testing'
import { cliFixture } from './cli-fixtures'
import { reconnectDelay, validateAttachmentReceipt, validatePublicationReceipt } from './command-outcomes'

test('attachment receipts require the intended directory, operation, and usable reference', () => {
  const directory = cliFixture('attach').directory
  validateAttachmentReceipt(cliFixture('attach'), directory)
  validateAttachmentReceipt(cliFixture('attach', { directory: 'C:/repo/delta' }), String.raw`C:\repo\delta`)
  for (const patch of [{ reference: ' ' }, { reference: undefined }, { directory: '/other' }, { directory: undefined }, { operation: 'invalid' }])
    expect(() => validateAttachmentReceipt(cliFixture('attach', patch), directory)).toThrow()
})

test('publication receipts identify the same thread and carry a safe web link', () => {
  const thread = cliFixture('share').thread_id
  validatePublicationReceipt(cliFixture('share'), thread)
  for (const patch of [{ thread_id: 'other-thread' }, { url: 'javascript:alert(1)' }, { operation: 'invalid' }])
    expect(() => validatePublicationReceipt(cliFixture('share', patch), thread)).toThrow()
})

test('reconnecting uses capped backoff', () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000])
})
