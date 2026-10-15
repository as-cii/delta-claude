import { describe, expect, test as kitTest, tier } from 'claude-code/testing'
import type { Engine } from 'claude-code'
import {
  CHECKOUT, abovePrompt, fakeThreads, prompt, sessionEnd, sessionStart, testsWithHeldClockWait, turnComplete, turnStart, typedDelta,
} from './fake-thread-commands'

tier('user')

const test = testsWithHeldClockWait(kitTest)
const POLICY = '/repo/.delta/settings.json'
/** A registered thread's status cannot reach the server while Delta is offline. */
const OFFLINE_STATUS = { operation: 'status', code: 'app_unavailable', message: 'Cannot reach Delta' } as const

/** The status band's drawn tree as text, for asserting what the person sees. */
const drawn = async ($: Engine) => JSON.stringify(await $.ui.render(abovePrompt))
/** The band as drawn when Claude gives it only `maxRows` rows. */
const drawnInRows = async ($: Engine, maxRows: number) =>
  JSON.stringify(await $.ui.render({ ...abovePrompt, props: { ...abovePrompt.props, maxRows } }))

function policy(mode: 'manual' | 'private' | 'organization', organization?: string) {
  return JSON.stringify({ threads: { mode, organization } })
}

/** Store a session that ended long ago, with its ledger; `overrides` change any binding field. */
function seedEnded(store: Map<string, unknown>, id: string, overrides: Record<string, unknown> = {}) {
  store.set(`session:${id}`, { session: id, snapshot: true, next: 1, pending: [], endedAt: -10 * 365 * 24 * 60 * 60 * 1000, ...overrides })
  store.set(`appended:${id}`, { thread: 't', items: {} })
}

function binding(fake: ReturnType<typeof fakeThreads>) {
  return fake.store.get(`session:${fake.session}`) as any
}

async function startAuto($: Engine, fake: ReturnType<typeof fakeThreads>, source = 'startup') {
  await $.session.start(sessionStart)
  await $.classic.SessionStart({ session_id: fake.session, source, cwd: CHECKOUT, transcript_path: '' } as never)
  await fake.clock.settle()
  await fake.clock.advance(0)
  await fake.clock.settle()
}

/** Make the server refuse the thread's recorded changes, as an append that keeps failing until resolved. */
function refuseChanges(fake: ReturnType<typeof fakeThreads>, fork?: string) {
  fake.refusedChanges = { fork }
}

describe('automatic activation', () => {
  test('a new session in a policy repository creates with its upload intent, attaches, and watches without sharing', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)

    expect(fake.server.thread).toBe(fake.threadId)
    expect(fake.server.upload).toEqual({ organization: 'org-1', visibility: 'private' })
    expect(fake.server.mount).toMatchObject({ thread: fake.threadId, directory: CHECKOUT })
    expect(fake.operations()).toEqual(expect.arrayContaining(['create', 'attach']))
    // Private mode never publishes: activation must not run `thread share`.
    expect(fake.operations()).not.toContain('share')
    expect(fake.server.shared).toBe(false)
    expect(fake.live()?.ready).toBe(true)
    expect(binding(fake)).toMatchObject({ autoUpload: expect.anything(), snapshot: true, thread: fake.threadId, checkout: CHECKOUT })
    // The session is new, so nothing is exported.
    expect(fake.exports).toBe(0)
    fake.expectClean()
  })

  // Resume and fork take the same branch: only `startup` and `clear` start a new session.
  test('a resumed session never activates', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-1'))
    await startAuto($, fake, 'resume')
    expect(fake.server.thread).toBeUndefined()
    expect(fake.operations()).not.toContain('create')
    expect(binding(fake)).toBeUndefined()
    fake.expectClean()
  })

  test('a clear session activates and uploads to the organization', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-1'))
    await startAuto($, fake, 'clear')
    expect(fake.server.thread).toBe(fake.threadId)
    expect(fake.server.upload).toEqual({ organization: 'org-1', visibility: 'organization' })
    fake.expectClean()
  })

  test('a session that already holds a binding is never created again', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    // A saved binding may be an earlier share, a pending join, or a resume; activation never replaces it.
    fake.store.set(`session:${fake.session}`, { session: fake.session, snapshot: true, next: 4, pending: [], thread: 'existing-thread' })
    await startAuto($, fake)
    expect(fake.server.thread).toBeUndefined()
    expect(fake.operations()).not.toContain('create')
    fake.expectClean()
  })

  test('a CLI that speaks only contract 2 disables auto mode with a notice', async ($, on) => {
    const fake = fakeThreads(on)
    fake.contractRange = { min: 1, max: 2 }
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    expect(fake.server.thread).toBeUndefined()
    expect(fake.logs.join('\n')).toContain('must be updated for automatic uploads')
    expect(binding(fake)).toBeUndefined()
    fake.expectClean()
  })

  test('holds the first prompt, row, and turn until the auto decision, so none is lost', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    let release!: () => void
    // Hold the contract check itself, not create/attach: this is the window before staging.
    fake.holdRun = (operation) => operation === 'contract'
      ? new Promise<void>((resolve) => { release = resolve }) : undefined
    await $.session.start(sessionStart)
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    // The decision is still pending: nothing is staged, so an unfixed session would drop what follows.
    expect(fake.store.get(`session:${fake.session}`)).toBeUndefined()

    const submitted = $.prompt.submit(prompt('first'))
    const appended = $.session.append({
      door: 'prompt', origin: { kind: 'composer' }, uuid: 'first-prompt',
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'first' }] },
    } as never)
    const starting = $.turn.start(turnStart('native-first', 'first'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])

    release()
    expect((await submitted).drop).toBeUndefined()
    await appended
    await starting
    await fake.clock.settle()
    await $.turn.complete(turnComplete('native-first'))
    await fake.clock.settle()
    await fake.clock.advance(120_000)
    await fake.clock.settle()

    expect(fake.updates().some((record) => JSON.stringify(record.update).includes('first'))).toBe(true)
    expect(fake.finishes()).toEqual(fake.starts())
    fake.expectClean()
  })

  test('a new session without a policy never holds a prompt behind the open setup offer', async ($, on) => {
    const fake = fakeThreads(on)
    let answer!: (value: unknown) => void
    fake.answerQuestion = () => new Promise((resolve) => { answer = resolve })
    await $.session.start(sessionStart)
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.questions).toHaveLength(1)
    let answered = false
    const submitted = $.prompt.submit(prompt('while the offer is open')).then((result) => { answered = true; return result })
    await fake.clock.settle()
    expect(answered).toBe(true)
    answer({ result: { answers: { [fake.questions[0].questions[0].question]: 'Not now' } } })
    expect((await submitted).drop).toBeUndefined()
    await fake.clock.settle()
    fake.expectClean()
  })

  test('a session that ends during attach starts no watcher and gives no share advice', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    let release!: () => void
    fake.holdRun = (operation) => operation === 'attach'
      ? new Promise<void>((resolve) => { release = resolve }) : undefined
    await $.session.start(sessionStart)
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    // Attach is pending; the session ends, then attach completes.
    await $.session.end(sessionEnd(fake.session))
    release()
    await fake.clock.settle()
    expect(fake.watches).toHaveLength(0)
    expect(fake.logs.join('\n')).not.toContain('/delta share')
    fake.expectClean()
  })
})

describe('the band on an automatic session', () => {
  test('shows the link and its audience once Delta finishes the background upload, without a prompt or a share', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-1'))
    fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }]
    // `thread create` returns the upload intent before Delta registers the thread, so the first
    // status has no link. The upload is the band's operation, like a share's steps, so even a
    // one-row band shows it.
    await startAuto($, fake)
    expect(await drawnInRows($, 1)).toContain('Waiting to upload…')
    // Delta registers the thread: the URL appears, but the content upload is still running, so the
    // first-upload operation stays on the band's row instead of moving to a hidden second row.
    fake.server.registered = true
    await fake.clock.advance(1_000)
    await fake.clock.settle()
    await drawn($)
    await fake.clock.settle()
    const registering = await drawnInRows($, 1)
    expect(registering).toContain('Uploading to Delta…')
    expect(registering).not.toContain('Uploaded to Delta')
    // Only Delta's confirmation of the content ends the first-upload operation.
    fake.server.confirmed = true
    await fake.clock.advance(2_000)
    await fake.clock.settle()
    await drawn($)
    await fake.clock.settle()
    const finished = await drawn($)
    expect(finished).toContain('Uploaded to Delta')
    expect(finished).toContain(`https://delta.dev/join/${fake.shareId}`)
    expect(finished).toContain('Shared with Zed')
    await fake.clock.advance(5_000)
    await fake.clock.settle()
    const band = await drawn($)
    expect(band).toContain(`https://delta.dev/join/${fake.shareId}`)
    expect(band).not.toContain('Uploaded to Delta')
    // Organization mode reaches the organization through the upload, never through `thread share`.
    expect(fake.server.shared).toBe(false)
    fake.expectClean()
  })

  test('a failed background upload shows its reason on the band', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    // Delta registered the thread but rejected the content upload, so the URL exists and the upload failed.
    fake.server.registered = true
    fake.server.uploadFailure = 'storage quota exceeded'
    await startAuto($, fake)
    await fake.clock.advance(1_000)
    await fake.clock.settle()
    await drawn($)
    await fake.clock.settle()
    const band = await drawn($)
    expect(band).toContain('Upload failed: storage quota exceeded')
    expect(band).toContain(`https://delta.dev/join/${fake.shareId}`)
    expect(band).not.toContain('Uploaded to Delta')
    fake.expectClean()
  })

  test('follows the upload after activation even when the watcher never becomes ready', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    fake.server.registered = true
    fake.server.confirmed = true
    // The watcher never emits readiness, so only a status read made on its own can report the link.
    fake.onWatch = () => {}
    await startAuto($, fake)
    expect(fake.live()?.ready).toBe(false)
    await fake.clock.advance(2_000)
    await fake.clock.settle()
    expect(await drawn($)).toContain(`https://delta.dev/join/${fake.shareId}`)
    fake.expectClean()
  })

  test('a private thread offers a share control that publishes the same thread', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    fake.organizations = [{ id: 'org-1', name: 'Zed', current: true }]
    fake.server.registered = true
    fake.server.confirmed = true
    await startAuto($, fake)
    const thread = fake.server.thread
    // The first draw reads the organization directory; the next one names it.
    await drawn($)
    await fake.clock.settle()
    await drawn($)
    await fake.clock.settle()
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Share with Zed' })
    await terminal.press({ key: 'share' })
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    // The existing thread is published in place: no new thread, no re-export.
    expect(fake.server.thread).toBe(thread)
    expect(fake.operations().filter((operation) => operation === 'create')).toHaveLength(1)
    expect(fake.operations()).toContain('share')
    expect(fake.exports).toBe(0)
    fake.expectClean()
  })
})

describe('offline recording', () => {
  test('keeps a prompt and its turn while Delta is unreachable, then drains after reconnect', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)

    fake.commandFault = OFFLINE_STATUS
    fake.appendOffline = true
    expect((await $.prompt.submit(prompt('offline'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-offline', 'offline'))
    await fake.clock.settle()
    // The watcher's absence does not stop Claude's turn.
    expect(fake.aborts).toEqual([])
    // Records are appended with local acknowledgment and stay queued.
    expect(fake.delta().some((argv) => argv.includes('--acknowledge') && argv.includes('local'))).toBe(true)
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    await $.turn.complete(turnComplete('native-offline'))
    await fake.clock.settle()

    // Delta comes back; the retry drains everything without a replayed prompt.
    fake.commandFault = undefined
    fake.appendOffline = false
    await fake.clock.advance(120_000)
    await fake.clock.settle()
    expect(binding(fake).pending).toEqual([])
    expect(fake.finishes()).toEqual(fake.starts())
    expect(fake.entered).toHaveLength(1)
    fake.expectClean()
  })

  test('a /delta share session records offline like an automatic one', async ($, on) => {
    const fake = fakeThreads(on)
    await $.session.start(sessionStart)
    await fake.share($)
    // A shared thread is registered, so Delta's background uploader pushes what it acknowledges
    // locally: delivery while Delta is unreachable neither blocks Claude nor drops the prompt.
    fake.commandFault = OFFLINE_STATUS
    fake.appendOffline = true
    expect((await $.prompt.submit(prompt('shared offline'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-shared', 'shared offline'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    expect(fake.delta().some((argv) => argv.includes('--acknowledge') && argv.includes('local'))).toBe(true)
    fake.commandFault = undefined
    fake.appendOffline = false
    await fake.clock.advance(120_000)
    await fake.clock.settle()
    expect(binding(fake).pending).toEqual([])
    fake.expectClean()
  })

  test('a non-retryable refusal pauses delivery but never drops a prompt or publishes', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    fake.commandFault = { operation: 'append', code: 'not_visible', message: 'thread deleted', retryable: false }
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-nonretry'))
    await fake.clock.settle()
    expect((fake.store.get(`session:${fake.session}`) as any).pending.length).toBeGreaterThan(0)
    // A delivery pause stops delivery, not Claude: the next prompt retries and is accepted.
    expect((await $.prompt.submit(prompt('next'))).drop).toBeUndefined()
    await fake.clock.settle()
    // The turn keeps running, and an automatic session never publishes as recovery.
    expect(fake.aborts).toEqual([])
    expect(fake.operations()).not.toContain('share')
    fake.expectClean()
  })

  test('a refused offline append pauses delivery, keeps prompts, and shows both controls until resolved', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    refuseChanges(fake)
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-refused', 'one'))
    await fake.clock.settle()
    // The records stay queued and Claude keeps working: the pause stops delivery, not the turn.
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    expect(fake.aborts).toEqual([])
    expect(await drawn($)).toContain("Delta couldn't publish this thread's offline changes.")
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Fork & Restore' })
    await terminal.find({ type: 'Button', label: 'Discard' })
    // A further prompt is accepted and its records stay queued, not lost.
    expect((await $.prompt.submit(prompt('still here'))).drop).toBeUndefined()
    await fake.clock.settle()
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    // Resolving it elsewhere lets the next append succeed, which clears the choice.
    fake.refusedChanges = undefined
    expect((await $.prompt.submit(prompt('resolved elsewhere'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-resolved', 'resolved elsewhere'))
    await fake.clock.settle()
    expect(binding(fake).pending).toEqual([])
    expect(await drawn($)).not.toContain('Fork & Restore')
    fake.expectClean()
  })

  test('Fork & Restore forks the refused changes, discards the original, and drains the queued records', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    refuseChanges(fake, 'thread-fork-1')
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-fork', 'one'))
    await fake.clock.settle()
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Fork & Restore' })
    await terminal.press({ key: 'fork' })
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.operations()).toEqual(expect.arrayContaining(['fork', 'discard']))
    expect(binding(fake).pending).toEqual([])
    expect(fake.logs.filter((log) => log.includes('thread-fork-1'))).toHaveLength(1)
    expect(await drawn($)).not.toContain('Fork & Restore')
    fake.expectClean()
  })

  test('a failed discard after a fork stays paused with the controls and can fork again', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    refuseChanges(fake, 'thread-fork-2')
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-fork-failed', 'one'))
    await fake.clock.settle()
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    // The discard fails after the fork, so the refusal stays and the person may try again.
    fake.commandFault = { operation: 'discard', code: 'failed', message: 'discard failed', retryable: false }
    await terminal.find({ type: 'Button', label: 'Fork & Restore' })
    await terminal.press({ key: 'fork' })
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.operations()).toEqual(expect.arrayContaining(['fork', 'discard']))
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    expect(await drawn($)).toContain('Fork & Restore')
    fake.expectClean()
  })

  test('Discard drops the refused changes and drains the queued records', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    await startAuto($, fake)
    refuseChanges(fake)
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-discard', 'one'))
    await fake.clock.settle()
    expect(binding(fake).pending.length).toBeGreaterThan(0)
    const terminal = await $.ui.mount({ plugin: 'delta', surface: 'terminal', component: 'AbovePrompt', props: { ...abovePrompt.props } })
    await terminal.find({ type: 'Button', label: 'Discard' })
    await terminal.press({ key: 'discard' })
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(fake.operations()).toContain('discard')
    expect(binding(fake).pending).toEqual([])
    expect(await drawn($)).not.toContain('Discard')
    fake.expectClean()
  })

  // Create and attach leave the same staged binding until both finish, so holding attach covers
  // the window for either.
  test('a prompt and rows arriving during activation are accepted and drain once it completes', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-1'))
    let release!: () => void
    fake.holdRun = (operation) => operation === 'attach' ? new Promise<void>((resolve) => { release = resolve }) : undefined
    await $.session.start(sessionStart)
    await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    // The thread exists but the checkout is not attached: a prompt must still be accepted, and its
    // turn must not be stopped, while activation is in flight.
    expect(binding(fake).thread).toBeUndefined()
    expect((await $.prompt.submit(prompt('during attach'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-attach'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    release()
    await fake.clock.settle()
    await fake.clock.advance(120_000)
    await fake.clock.settle()
    expect(binding(fake)).toMatchObject({ thread: fake.threadId, checkout: CHECKOUT, pending: [] })
    expect(fake.operations()).not.toContain('share')
    fake.expectClean()
  })

  test('a session that ended before activation finished completes it on resume without dropping a prompt or stopping its turn', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('private', 'org-1'))
    fake.commandFault = { operation: 'create', code: 'app_unavailable', message: 'Delta is unreachable', retryable: true }
    await startAuto($, fake)
    expect(binding(fake)).toMatchObject({ autoUpload: expect.anything(), snapshot: true })
    expect(binding(fake).thread).toBeUndefined()
    await $.session.end(sessionEnd(fake.session))
    expect(binding(fake).endedAt).toEqual(expect.any(Number))

    fake.commandFault = undefined
    await startAuto($, fake, 'resume')
    expect((await $.prompt.submit(prompt('after resume'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-resumed'))
    await fake.clock.settle()
    expect(fake.aborts).toEqual([])
    await fake.clock.advance(120_000)
    await fake.clock.settle()
    expect(binding(fake)).toMatchObject({ thread: fake.threadId, checkout: CHECKOUT })
    expect(binding(fake).endedAt).toBeUndefined()
    expect(fake.server.upload).toEqual({ organization: 'org-1', visibility: 'private' })
    expect(fake.operations()).not.toContain('share')
    fake.expectClean()
  })

  test('a policy naming an organization the account is not in records nothing and explains once per repository', async ($, on) => {
    const fake = fakeThreads(on)
    fake.files.set(POLICY, policy('organization', 'org-other'))
    const explained = () => fake.logs.filter((log) => log.includes("org-other, which your Delta account isn't a member of")).length
    await startAuto($, fake)
    // The membership check runs before staging, so nothing is created or queued.
    expect(fake.operations()).not.toContain('create')
    expect(binding(fake)).toBeUndefined()
    expect(await drawn($)).toContain("isn't in this repo's organization")
    expect(explained()).toBe(1)
    expect((await $.prompt.submit(prompt('one'))).drop).toBeUndefined()
    await fake.clock.settle()
    expect(fake.operations()).not.toContain('create')
    expect(binding(fake)).toBeUndefined()

    // The next new session in the repository keeps the band line without repeating the explanation.
    await startAuto($, fake, 'clear')
    expect(await drawn($)).toContain("isn't in this repo's organization")
    expect(explained()).toBe(1)
    fake.expectClean()
  })

  test('a permanent refusal during activation stops recording and removes what was queued', { timeoutMs: 15_000 }, async ($, on) => {
    const fake = fakeThreads(on)
    // Memberships aren't loaded, so only the create itself can refuse.
    fake.organizations = []
    fake.files.set(POLICY, policy('private', 'org-1'))
    fake.commandFault = { operation: 'create', code: 'not_visible', reason: 'organization_not_member', message: 'not a member of org-1', retryable: false }
    let release!: () => void
    fake.holdRun = (operation) => operation === 'create' ? new Promise<void>((resolve) => { release = resolve }) : undefined
    await startAuto($, fake)
    expect((await $.prompt.submit(prompt('during create'))).drop).toBeUndefined()
    await $.turn.start(turnStart('native-refused', 'during create'))
    await fake.clock.settle()
    const queued = binding(fake).pending.flatMap((entry: any) => entry.files)
    expect(queued.length).toBeGreaterThan(0)

    release()
    await fake.clock.settle()
    expect(binding(fake)).toBeUndefined()
    expect(queued.filter((path: string) => fake.files.has(path))).toEqual([])
    expect(await drawn($)).toContain("isn't in this repo's organization")
    // Nothing retries: the next prompt is accepted without another create or a new queue.
    expect((await $.prompt.submit(prompt('after'))).drop).toBeUndefined()
    await fake.clock.settle()
    expect(fake.operations().filter((operation) => operation === 'create')).toHaveLength(1)
    expect(binding(fake)).toBeUndefined()
    fake.expectClean()
  })
})

describe('setup command and policy problems', () => {
  test('a headless session refuses /delta setup and never offers onboarding', async ($, on) => {
    const fake = fakeThreads(on)
    fake.surfaces = []
    await startAuto($, fake)
    expect(fake.delta().some((argv) => argv.includes('org'))).toBe(false)
    const answer = await $.command.run({ ...typedDelta('setup') } as never)
    expect((answer as any).text).toContain('needs an interactive Claude Code terminal')
    expect(fake.files.has(POLICY)).toBe(false)
    fake.expectClean()
  })

  test('a malformed policy is reported once and leaves the checkout recording manually', async ($, on) => {
    const fake = fakeThreads(on)
    const broken = '{ not json'
    fake.files.set(POLICY, broken)
    await startAuto($, fake)
    expect(fake.logs.join('\n')).toContain('could not be used')
    expect(fake.files.get(POLICY)).toBe(broken)
    expect(fake.server.thread).toBeUndefined()
    expect(fake.operations()).not.toContain('create')
    fake.expectClean()
  })
})

describe('store retention', () => {
  test('the store prunes a long-ended session through activation, and keeps every unsettled one', async ($, on) => {
    const fake = fakeThreads(on)
    const store = fake.store as Map<string, unknown>
    seedEnded(store, 'expired')
    seedEnded(store, 'marked-recent', { endedAt: 0 })
    seedEnded(store, 'keeper', { next: 5, pending: [{ sequence: 1, files: [], digest: 'x' }] })
    seedEnded(store, 'captured', { captureFailure: 'disk full' })
    seedEnded(store, 'joining', { joinTransition: { locator: 'x' } })
    seedEnded(store, 'live', { endedAt: undefined })
    await $.session.start(sessionStart)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    const keys = [...store.keys()]
    expect(keys).not.toContain('session:expired')
    expect(keys).not.toContain('appended:expired')
    // Never a binding without an end marker, one within the horizon, or one something still needs.
    for (const id of ['live', 'marked-recent', 'keeper', 'captured', 'joining']) expect(keys).toContain(`session:${id}`)
    fake.expectClean()
  })

  test('a session resumed in another process during pruning keeps its binding', async ($, on) => {
    const fake = fakeThreads(on)
    const store = fake.store as Map<string, unknown>
    seedEnded(store, 'resumed')
    seedEnded(store, 'later')
    // Pruning is still reading another session when a second Claude process resumes this one, which
    // drops its end marker and queues a record; nothing read before that may delete it afterwards.
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    let held = false
    fake.holdStoreGet = (storeKey) => storeKey === 'session:later' && !held ? (held = true, paused) : undefined
    await $.session.start(sessionStart)
    await fake.clock.settle()
    await fake.clock.advance(0)
    await fake.clock.settle()
    expect(held).toBe(true)
    store.set('session:resumed', { session: 'resumed', snapshot: true, next: 2, pending: [{ sequence: 1, files: [], digest: 'x' }] })
    release()
    await fake.clock.settle()
    expect(store.get('session:resumed')).toMatchObject({ pending: [{ sequence: 1 }] })
    fake.expectClean()
  })
})

describe('setup dialogs and notices', () => {
  test('/delta setup writes the policy after its questions are answered', async ($, on) => {
    const fake = fakeThreads(on)
    fake.answerQuestion = (question: any) => {
      const text = question.questions[0].question
      const answer = text.startsWith('Write this Delta policy') ? 'Write it' : 'Private upload'
      return { result: { answers: { [text]: answer } } }
    }
    await $.session.start(sessionStart)
    await $.command.run({ ...typedDelta('setup') } as never)
    expect(JSON.parse(fake.files.get(POLICY)!)).toEqual({ threads: { mode: 'private', organization: 'org-1' } })
    // The person sees exactly what will be written before confirming it.
    expect(fake.logs.join('\n')).toContain(`Delta will write ${POLICY}`)
    fake.expectClean()
  })

  test('the onboarding offer is shown once per repository, then never again', async ($, on) => {
    const fake = fakeThreads(on)
    fake.answerQuestion = (question: any) => ({
      result: { answers: { [question.questions[0].question]: 'Not now' } },
    })
    const startup = async () => {
      await $.session.start(sessionStart)
      await $.classic.SessionStart({ session_id: fake.session, source: 'startup', cwd: CHECKOUT } as never)
      await fake.clock.settle()
      await fake.clock.advance(0)
      await fake.clock.settle()
    }
    await startup()
    expect(fake.questions).toHaveLength(1)
    // A second session in the same repository sees the recorded marker and is not offered again.
    await $.session.end(sessionEnd(fake.session))
    await startup()
    expect(fake.questions).toHaveLength(1)
    fake.expectClean()
  })
})
