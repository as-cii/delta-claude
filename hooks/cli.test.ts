import { expect, test, tier } from 'claude-code/testing'
import { DeltaCli } from './cli'

tier('user')

test('existing executable is cached without running an installer', async () => {
  const calls: string[][] = []
  const run = async (argv: readonly string[]) => {
    calls.push([...argv])
    return output('/development build/delta\n')
  }
  const cli = new DeltaCli()
  expect(await cli.resolve(run, true)).toBe('/development build/delta')
  expect(await cli.resolve(run)).toBe('/development build/delta')
  expect(calls).toHaveLength(1)
  expect(calls[0]![2]).toContain('command -v delta')
  expect(calls[0]![2]).not.toContain('curl')
})

test('resume never installs, but explicit setup after missing discovery does', async () => {
  const calls: string[][] = []
  const run = async (argv: readonly string[]) => {
    calls.push([...argv])
    return argv[2]!.includes('--non-interactive') ? output('/installed/delta\n') : output('', 3)
  }
  const cli = new DeltaCli()
  await expect(cli.resolve(run)).rejects.toThrow(Error)
  expect(calls).toHaveLength(1)
  const progress: string[] = []
  expect(await cli.resolve(run, true, (text) => progress.push(text))).toBe('/installed/delta')
  expect(progress).toHaveLength(1)
  expect(calls).toHaveLength(3)
  expect(calls[2]![2]).toContain('--locate-cli')
  expect(calls[2]![2]).toContain('--non-interactive')
})

test('concurrent setup shares installation and failure; later retry succeeds', async () => {
  let installations = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const run = async (argv: readonly string[]) => {
    if (!argv[2]!.includes('--non-interactive')) return output('', 3)
    installations++
    await held
    return installations === 1 ? output('', 1, 'download failed') : output('/installed/delta\n')
  }
  const cli = new DeltaCli()
  const first = cli.resolve(run, true)
  const second = cli.resolve(run, true)
  release()
  await expect(first).rejects.toThrow(Error)
  await expect(second).rejects.toThrow(Error)
  expect(installations).toBe(1)
  expect(await cli.resolve(run, true)).toBe('/installed/delta')
  expect(installations).toBe(2)
})

test('discovery failures and malformed paths never authorize installation', async () => {
  let calls = 0
  const run = async () => {
    calls++
    return calls === 1 ? output('', 1, 'permission denied') : output('/delta\nunexpected output\n')
  }
  const cli = new DeltaCli()
  await expect(cli.resolve(run, true)).rejects.toThrow(Error)
  expect(calls).toBe(1)
  await expect(cli.resolve(run, true)).rejects.toThrow(Error)
  expect(calls).toBe(2)
})

test('Windows discovery selects the first native absolute path without a shell', async () => {
  for (const path of ['C:\\Program Files\\Delta\\delta.exe', '\\\\server\\tools\\delta.exe']) {
    const calls: string[][] = []
    const run = async (argv: readonly string[]) => {
      calls.push([...argv])
      return output(`${path}\r\nC:\\other\\delta.exe\r\n`)
    }
    const cli = new DeltaCli()
    expect(await cli.resolve(run, true, undefined, true)).toBe(path)
    expect(await cli.resolve(run, false, undefined, true)).toBe(path)
    expect(calls).toEqual([['where.exe', '$PATH:delta.exe']])
  }
})

test('Windows missing CLI and invalid discovery never invoke an installer', async () => {
  const calls: string[][] = []
  const progress: string[] = []
  const results = [output('', 1), output('C:delta.exe\r\n'), output('', 2, 'lookup failed')]
  const cli = new DeltaCli()
  const run = async (argv: readonly string[]) => {
    calls.push([...argv])
    return results.shift()!
  }
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(cli.resolve(run, true, (text) => progress.push(text), true)).rejects.toThrow(Error)
  expect(calls).toEqual(Array(3).fill(['where.exe', '$PATH:delta.exe']))
  expect(progress).toEqual([])
})

function output(stdout: string, exitCode = 0, stderr = '') {
  return { stdout, exitCode, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}
