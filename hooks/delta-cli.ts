/**
 * Running the Delta CLI for a session: finding the executable, the thread contract version the CLI
 * and this plugin agreed on, and one function per CLI operation the plugin uses, named after its
 * subcommand (`threadCreate` runs `delta thread create`). Each builds its arguments, runs them, and
 * returns the answer already checked. Only sign-in (`auth.ts`) and updates (`install-update.ts`),
 * which run through hosts their tests substitute, build a Delta command line anywhere else.
 */
import type { ProcessRunResult, ProcessSpawnResult } from 'claude-code'
import { DeltaCli } from './cli'
import {
  type AttachmentReceipt, checkResult, type CreationReceipt, type PublicationReceipt, validateAttachmentReceipt,
  validateCreationReceipt, validatePublicationReceipt,
} from './command-outcomes'
import { readCommandStream } from './command-reader'
import { isJsonObject, type JsonObject } from './json'
import { type Runtime, stillActive } from './session-state'
import {
  createdOrganizationFrom, type InviteResult, inviteResultsFrom, type Organization, organizationsFrom,
} from './setup'
import { threadInvitationsFrom } from './share-audience'
import { errorText } from './text'
import {
  contractRefusal, ContractRefusalError, contractVersion, DeltaCommandError, type ForkedThread, type MountedThread,
  parseThreadContract, parseThreadFork, parseThreadMount, parseThreadStatus, parseWatchEvent, PRODUCER_NAME,
  type ThreadContract, type WatchEvent,
} from './thread-commands'

/**
 * Marks a command as run by Claude Code, for Delta's telemetry of which integration ran each command.
 * Every Delta command this plugin runs carries it, sign-in's included.
 */
export const INTEGRATION_ENV = { DELTA_CLI_INTEGRATION: 'claude_code' }

/** How a person ran a share or join: `/delta share` (`delta_subcommand`) or `/delta-share` (`dedicated_command`). */
export type CommandForm = 'delta_subcommand' | 'dedicated_command'

/** The CLI environment that labels the command a share or join reports with how it was run, for Delta's telemetry. */
function commandFormEnv(form: CommandForm | undefined): Record<string, string> {
  return form ? { DELTA_CLI_COMMAND_FORM: form } : {}
}
const cli = new DeltaCli()
/** `thread contract` answers from the CLI binary without starting delta-app, so this bound only catches a wedged process. */
export const CONTRACT_TIMEOUT_MS = 30_000
/** A mount may materialize several large checkouts before it answers. */
const MOUNT_TIMEOUT_MS = 600_000
/** How long exiting waits for Delta to record a release. */
const RELEASE_TIMEOUT_MS = 5_000
/**
 * The contract version negotiated with each session's CLI build, once it answered a range this plugin
 * speaks; a refusal is never remembered. A capability newer than `PLUGIN_CONTRACT_MIN` is gated on it.
 */
const contractVerified = new Map<string, number>()

/** The contract version this session's CLI agreed to, once it did. */
export function verifiedContract(session: string): number | undefined {
  return contractVerified.get(session)
}

/** Remember a version for a session that runs against a CLI build this process already verified. */
export function rememberContract(session: string, version: number) {
  contractVerified.set(session, version)
}

/** A resumed session re-checks the CLI's contract, as a fresh process's first participation does. */
export function forgetContract(session: string) {
  contractVerified.delete(session)
}

/**
 * The Delta CLI's executable. Given `install`, a missing CLI is installed, with its progress reported
 * through `install`; without it, a missing CLI is an error, so only an explicit command installs.
 */
export async function resolveCli($: Runtime, install?: (progress: string) => void) {
  return cli.resolve((argv, init) => $.process.run(argv, { ...init, env: { ...init?.env, ...INTEGRATION_ENV } }),
    install !== undefined,
    install, await $.env.get('OS') === 'Windows_NT'
      ? { exists: (path) => $.fs.exists(path) } : false)
}

/**
 * Run `delta --json …args` as Claude Code, reading its output as it streams rather than through
 * process.run's capture limit. `name` names the command in its errors.
 */
async function readCommand($: Runtime, args: string[], name: string, options: {
  signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string>
} = {}): Promise<string> {
  const { signal = new AbortController().signal, timeoutMs = 120_000, env } = options
  if (signal.aborted) throw new Error(`Delta ${name} cancelled`)
  let stream: ReturnType<Runtime['process']['spawn']>
  try {
    const executable = await resolveCli($)
    if (signal.aborted) throw new Error(`Delta ${name} cancelled`)
    stream = $.process.spawn({ argv: [executable, '--json', ...args], env: { ...env, ...INTEGRATION_ENV } })
  }
  catch (error) { throw new DeltaCommandError('process_failed', `${name}: cannot run Delta CLI (${errorText(error)})`) }
  return readCommandStream(stream, name, signal,
    (milliseconds, deadline) => $.clock.sleep(milliseconds, { signal: deadline }), timeoutMs)
}

/**
 * Refuse to record against a CLI whose recording contract this plugin does not speak, and return
 * the newest version both speak. Runs once per session; a refusal or a process failure is not
 * remembered, so updating Delta and retrying re-checks. Nor is an answer that arrives after the
 * session ended or was activated again, even under the same ID, so a resumed session renegotiates.
 */
export async function requireContract($: Runtime, session: string): Promise<number> {
  const verified = contractVerified.get(session)
  if (verified !== undefined) return verified
  const current = stillActive(session)
  const range = await threadContract($)
  const refusal = contractRefusal(range)
  if (refusal) throw new ContractRefusalError(refusal)
  // contractRefusal refuses an undefined range, so the range is defined here.
  const version = contractVersion(range!)
  if (current()) contractVerified.set(session, version)
  return version
}

/**
 * Ask the CLI which recording contract versions it speaks, using the same invocation the recording
 * helpers use. It answers locally, so the answer needs no delta-app. Unlike `command`, the exit code
 * and empty stdout are inspected first, so a CLI that predates the subcommand (clap's error on
 * stderr, nonzero exit, no JSON) reads as `undefined` rather than a generic malformed-output failure.
 */
export async function threadContract($: Runtime): Promise<ThreadContract | undefined> {
  let result: ProcessRunResult
  try {
    result = await runJson($, ['thread', 'contract'], { timeoutMs: CONTRACT_TIMEOUT_MS })
  } catch (error) {
    // The same failure a share or a status read reports when the CLI is missing or cannot start.
    throw new Error(`thread contract: cannot run Delta CLI (${errorText(error)}). Repair the selected Delta CLI and retry.`)
  }
  if (result.isStdoutTruncated || result.isStderrTruncated)
    throw new Error('thread contract: Delta CLI output truncated; no contract assumed')
  if (result.exitCode !== 0 && !result.stdout.trim()) return undefined
  return parseThreadContract(result.stdout)
}

/**
 * Run `delta --json …args` as Claude Code with `runJson`, returning its checked JSON answer. `name`
 * names the command in its errors.
 */
async function command($: Runtime, args: string[], name: string, options: {
  check?: () => Promise<void>; timeoutMs?: number; env?: Record<string, string>
} = {}) {
  let result: ProcessRunResult
  try {
    result = await runJson($, args, { ...options, timeoutMs: options.timeoutMs ?? 120_000 })
  } catch (error) {
    throw new Error(`${name}: cannot run Delta CLI (${errorText(error)}). Install the matching new Delta CLI and app, and put delta on PATH.`)
  }
  return checkResult(result, name)
}

/**
 * Run `delta --json …args` as Claude Code. `check` runs once the CLI is found, before the command;
 * a failure to find the CLI, pass the check or run the command is thrown as it is.
 */
async function runJson($: Runtime, args: string[], options: {
  timeoutMs: number; stdin?: string; env?: Record<string, string>; check?: () => Promise<void>
}): Promise<ProcessRunResult> {
  const { timeoutMs, stdin, env, check } = options
  const executable = await resolveCli($)
  if (check) await check()
  return $.process.run([executable, '--json', ...args], {
    ...stdin !== undefined ? { stdin } : {}, timeoutMs, env: { ...env, ...INTEGRATION_ENV },
  })
}

/**
 * Let the CLI own organization selection and its human-readable result: `org list`, `org current`,
 * `org switch`, or `org invite` into the current organization.
 */
export async function orgCommand(
  $: Runtime, request: 'list' | 'current' | { switch: string } | { invite: string[] },
) {
  const args = typeof request === 'string' ? [request]
    : 'switch' in request ? ['switch', '--', request.switch] : ['invite', '--', ...request.invite]
  try {
    const executable = await resolveCli($)
    const result = await $.process.run([executable, 'org', ...args], {
      timeoutMs: 120_000, env: { ...INTEGRATION_ENV },
    })
    if (result.isStdoutTruncated || result.isStderrTruncated)
      throw new Error('Delta team output was truncated; check the selection with /delta-org current.')
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Delta exited with code ${result.exitCode}`)
    return { text: result.stdout.trim() }
  } catch (error) {
    return { text: `Delta team command failed: ${errorText(error)}` }
  }
}

/** The account's organizations, from `delta --json org list`. */
export async function orgList($: Runtime, timeoutMs?: number): Promise<Organization[]> {
  return organizationsFrom(await command($, ['org', 'list'], 'org list', { timeoutMs }))
}

/** Create a team organization named `name`. */
export async function orgCreate($: Runtime, name: string): Promise<Organization> {
  return createdOrganizationFrom(await command($, ['org', 'create', '--', name], 'org create'))
}

/** Invite `emails` to `organization`, with each address's outcome. */
export async function orgInvite($: Runtime, organization: string, emails: string[]): Promise<InviteResult[]> {
  return inviteResultsFrom(await command($, ['org', 'invite', '--org', organization, '--', ...emails], 'org invite'))
}

/** The signed-in account's GitHub login, from `delta --json auth status`. */
export async function authStatus($: Runtime): Promise<{ login: string | undefined }> {
  const { account } = await command($, ['auth', 'status'], 'auth status')
  return { login: isJsonObject(account) && typeof account.login === 'string' ? account.login : undefined }
}

/**
 * Create, or find, the thread `externalId` records into. `organization` creates it under that
 * organization with that visibility; `parent` makes it a subagent's thread, named and with its
 * parent's worktrees or forks of them. `check` runs once the CLI is found, before the command.
 */
export async function threadCreate($: Runtime, creation: {
  externalId: string
  organization?: { id: string; visibility: 'private' | 'organization' }
  parent?: { reference: string; name: string; worktrees?: 'shared' | 'isolated' }
  check?: () => Promise<void>
}): Promise<JsonObject & CreationReceipt> {
  const { externalId, organization, parent, check } = creation
  const created = await command($, ['thread', 'create', '--source', 'claude-code', '--external-id', externalId,
    ...organization ? ['--organization', organization.id, '--visibility', organization.visibility] : [],
    ...parent ? ['--parent', parent.reference, '--name', parent.name] : [],
    ...parent?.worktrees ? [`--${parent.worktrees}-worktrees`] : []], 'thread create', { check })
  validateCreationReceipt(created)
  return created
}

/** Sync diagnostics can exceed process.run's 4 MiB stdout capture limit, so status streams with a bound. */
export async function threadStatus(
  $: Runtime, thread: string, session: string, signal = new AbortController().signal,
) {
  return parseThreadStatus(await readCommand($, ['thread', 'status', thread,
    '--source', 'claude-code', '--external-id', session], 'thread status', { signal }))
}

/** Publish `thread` to its organization, returning the link Delta gave it. */
export async function threadShare(
  $: Runtime, thread: string, options: { form?: CommandForm; check?: () => Promise<void> } = {},
): Promise<JsonObject & PublicationReceipt> {
  const shared = await command($, ['thread', 'share', thread, '--visibility', 'organization'], 'thread share',
    { check: options.check, env: commandFormEnv(options.form) })
  validatePublicationReceipt(shared, thread)
  return shared
}

/** Invite `emails` to `thread`, which uploads it privately if it is not on the server yet. */
export async function threadInvite(
  $: Runtime, thread: string, emails: string[], options: { form?: CommandForm; check?: () => Promise<void> } = {},
): Promise<{ url: string; results: InviteResult[] }> {
  return threadInvitationsFrom(await command($, ['thread', 'invite', thread, '--', ...emails],
    'thread invite', { check: options.check, env: commandFormEnv(options.form) }), thread)
}

/**
 * Mount every worktree of the thread `locator` names for `owner`. `folder` makes even a one-worktree
 * thread's directory its thread folder; `join` reports the mount as a join, run as `form`.
 */
export async function threadMount($: Runtime, mount: {
  locator: string; owner: string; folder?: boolean; join?: boolean; form?: CommandForm
}): Promise<MountedThread> {
  const { locator, owner, join } = mount
  const args = ['thread', 'mount', locator, '--owner', owner, ...mount.folder ? ['--folder'] : []]
  if (join) args.push('--join')
  // A first mount can materialize large checkouts, which the CLI waits for.
  return parseThreadMount(await readCommand($, args, 'thread mount', {
    timeoutMs: MOUNT_TIMEOUT_MS, env: join ? commandFormEnv(mount.form) : {},
  }), owner)
}

/** Release `owner`'s mounts of `thread`, leaving its exit status to the caller. */
export async function threadUnmount($: Runtime, thread: string, owner: string): Promise<ProcessRunResult> {
  return runJson($, ['thread', 'unmount', thread, '--owner', owner], { timeoutMs: RELEASE_TIMEOUT_MS })
}

/** Fork a refused thread's offline changes into a kept thread. */
export async function threadFork($: Runtime, thread: string): Promise<ForkedThread> {
  return parseThreadFork((await runRefusalCommand($, 'fork', thread)).stdout)
}

/** Discard a refused thread's offline changes, so it is the server's view again. */
export async function threadDiscard($: Runtime, thread: string): Promise<JsonObject> {
  return checkResult(await runRefusalCommand($, 'discard', thread), 'thread discard')
}

/** Run one `thread fork` or `thread discard` for a refused thread, failing with a typed error on a broken run. */
async function runRefusalCommand($: Runtime, kind: 'fork' | 'discard', thread: string): Promise<ProcessRunResult> {
  const args = kind === 'fork' ? ['thread', 'fork', thread] : ['thread', 'discard', thread, '--force']
  let result: ProcessRunResult
  try {
    result = await runJson($, args, { timeoutMs: 120_000 })
  } catch (error) { throw new DeltaCommandError('process_failed', `thread ${kind} did not finish (${errorText(error)})`) }
  if (result.isStdoutTruncated || result.isStderrTruncated)
    throw new DeltaCommandError('command_failed', `thread ${kind} output was truncated`)
  return result
}

/**
 * Append the JSON lines `input` to `target.reference` as the producer `target.externalId`; `local`
 * asks for a local acknowledgment. Returns the untruncated run, whose acknowledgments the caller
 * reads against the records it sent.
 */
export async function threadAppend(
  $: Runtime, target: { reference: string; externalId: string; local: boolean }, input: string,
): Promise<ProcessRunResult> {
  // Every append names the producer, retries included, so attribution never depends on a live watch.
  const args = ['thread', 'append', target.reference, '--source', 'claude-code', '--external-id', target.externalId,
    ...target.local ? ['--acknowledge', 'local'] : [], '--producer-name', PRODUCER_NAME]
  // A CLI that cannot be found fails as itself; only a run that does not finish is a process failure.
  await resolveCli($)
  let result: ProcessRunResult
  try {
    result = await runJson($, args, { stdin: input, timeoutMs: 120_000 })
  } catch (error) { throw new DeltaCommandError('process_failed', `append did not finish (${errorText(error)})`) }
  if (result.isStdoutTruncated || result.isStderrTruncated)
    throw new DeltaCommandError('command_failed', 'append output was truncated, so no acknowledgment is assumed')
  return result
}

/**
 * Start watching the thread `reference`, as the producer `externalId` when given; `participate`
 * also shows the signed-in person taking part through Claude Code while the watch runs. `proceed`
 * runs once the CLI is found, and a `false` answer starts nothing and returns undefined.
 */
export async function threadWatch(
  $: Runtime, reference: string,
  options: { externalId?: string; participate?: boolean; proceed?: () => boolean | Promise<boolean> } = {},
): Promise<ReturnType<Runtime['process']['spawn']> | undefined> {
  const { externalId, participate, proceed } = options
  const argv = [await resolveCli($), '--json', 'thread', 'watch', reference,
    ...externalId ? ['--source', 'claude-code', '--external-id', externalId] : [],
    ...participate ? ['--participate', PRODUCER_NAME] : []]
  if (proceed && !await proceed()) return undefined
  return $.process.spawn({ argv, env: { ...INTEGRATION_ENV } })
}

/** The longest `thread watch` line read; a snapshot item arrives whole on one line. */
const MAX_WATCH_LINE = 16 * 1024 * 1024

/**
 * The events a `thread watch` process prints, one JSON line each on stdout, until it exits, returning
 * how it exited. Its stderr goes to `stderr`. A line naming an event this plugin does not know is
 * skipped, and an error event is thrown.
 */
export async function* watchEvents(
  stream: ReturnType<Runtime['process']['spawn']>, stderr?: (text: string) => void,
): AsyncGenerator<WatchEvent, ProcessSpawnResult> {
  let pending = ''
  for (;;) {
    const piece = await stream.next()
    if (piece.done) return piece.value
    if (piece.value.stream === 'stderr') {
      stderr?.(piece.value.text)
      continue
    }
    pending += piece.value.text
    if (pending.length > MAX_WATCH_LINE) throw new Error('Delta watch event exceeds the watcher limit')
    let end: number
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      const event = line.trim() ? parseWatchEvent(line) : undefined
      if (event?.type === 'error') throw event.error
      if (event) yield event
    }
  }
}

/** The shell command line that merges the forked thread `reference` into the thread `into`. */
export async function threadMergeCommandLine($: Runtime, reference: string, into: string): Promise<string> {
  return `${shellQuote(await resolveCli($))} thread merge ${shellQuote(reference)} --into ${shellQuote(into)}`
}

/** A word for a POSIX shell, quoted unless it is plainly safe as it is. */
function shellQuote(word: string): string {
  return /^[\w@%+=:,./#-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

/** Attach the checkout `directory` to `thread`. `check` runs once the CLI is found, before the command. */
export async function worktreeAttach(
  $: Runtime, directory: string, thread: string, check?: () => Promise<void>,
): Promise<JsonObject & AttachmentReceipt> {
  const attached = await command($, ['worktree', 'attach', directory, '--thread', thread], 'worktree attach', { check })
  validateAttachmentReceipt(attached, directory)
  return attached
}

/** Detach the checkout `directory`, attached as `reference`, from `thread`, within `timeoutMs`. */
export async function worktreeUnmount(
  $: Runtime, worktree: { reference: string; directory: string; thread: string }, timeoutMs: number,
): Promise<JsonObject> {
  return command($, ['worktree', 'unmount', worktree.reference, worktree.directory, '--thread', worktree.thread],
    'worktree unmount', { timeoutMs })
}
