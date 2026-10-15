import { expect, test } from 'claude-code/testing'
import { newSessionLink } from './handoff'

test("Desktop's new-session link carries the folder and the message, encoded", () => {
  const url = new URL(newSessionLink('/Users/a/Application Support/thread-mounts/x', 'Join & go'))
  expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('claude://code/new')
  expect(url.searchParams.get('folder')).toBe('/Users/a/Application Support/thread-mounts/x')
  expect(url.searchParams.get('q')).toBe('Join & go')
})
