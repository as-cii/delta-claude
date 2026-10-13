import { expect, test } from 'claude-code/testing'
import { activeBackgroundAgents, hasInteractiveSurface, joinPreflight, missingJoinCommands, promptGate, releasesMounts, worktreeChanges } from './lifecycle'
import { cliFixture } from './cli-fixtures'
import type { MountedThread, ThreadMount, ThreadState } from './thread-commands'

test('only exit reasons release session mounts', () => {
  for (const reason of ['prompt_input_exit', 'logout', 'other']) expect(releasesMounts(reason)).toBe(true)
  for (const reason of ['clear', 'resume']) expect(releasesMounts(reason)).toBe(false)
})

test('terminal and desktop are interactive, while headless hosts are not', () => {
  expect(hasInteractiveSurface(['terminal'])).toBe(true)
  expect(hasInteractiveSurface(['desktop'])).toBe(true)
  expect(hasInteractiveSurface([])).toBe(false)
  expect(hasInteractiveSurface(['sdk', 'print'])).toBe(false)
})

test('join checks every required built-in, not commands with matching plugin names', () => {
  for (const missing of ['clear', 'cd']) {
    const commands = ['clear', 'cd'].map((name) => ({ name, source: name === missing ? 'plugin' : 'builtin' }))
    expect(missingJoinCommands(['clear', 'cd'], commands)).toEqual([missing])
  }
  expect(missingJoinCommands(['cd'], [{ name: 'cd', source: 'builtin' }])).toEqual([])
})

test('only completed, failed, or killed background agents permit joining', () => {
  for (const status of ['completed', 'failed', 'killed']) expect(activeBackgroundAgents([{ status }])).toBe(false)
  for (const status of ['running', 'pending']) expect(activeBackgroundAgents([{ status }])).toBe(true)
  expect(activeBackgroundAgents([])).toBe(false)
})

test('join preflight refuses empty worktrees and unauthenticated access before clearing', () => {
  const status = cliFixture('status') as ThreadState
  expect(joinPreflight(status)).toBe('empty')
  expect(joinPreflight({ ...status, access: { state: 'local_only', is_owner: null } })).toBe('access')
})

test('pending share and join operations hold prompts until the operation ends', () => {
  expect(promptGate({ joining: true })).toBe('joining')
  expect(promptGate({ sharing: true })).toBe('sharing')
  expect(promptGate({})).toBeUndefined()
})

test('worktree changes name additions and removals, moving out of a checkout only once', () => {
  const delta = { reference: 'delta', name: 'delta', directory: '/checkout/delta', state: 'mounted' } as ThreadMount
  const zed = { reference: 'zed', name: 'zed', directory: '/checkout/zed', state: 'mounted' } as ThreadMount
  const web = { reference: 'web', name: 'web', directory: '/checkout/web', state: 'mounted' } as ThreadMount
  for (const [previous, directory, next, added, removed, moves] of [
    [[delta], '/checkout/delta', [delta, zed], ['zed'], [], true],
    [[delta, zed], '/folder', [delta, zed, web], ['web'], [], false],
    [[delta, zed, web], '/folder', [delta, web], [], ['zed'], false],
    [[delta, web], '/folder', [delta], [], ['web'], false],
  ] as const) {
    const result = worktreeChanges(previous, directory,
      { ...cliFixture('mount'), directory: '/folder', worktrees: [...next] } as MountedThread)
    expect(result.added.map((tree) => tree.name)).toEqual([...added])
    expect(result.removed.map((tree) => tree.name)).toEqual([...removed])
    expect(result.moves).toBe(moves)
  }
})
