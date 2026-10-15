//! The `/delta setup` wizard and the once-per-repository onboarding offer.
//!
//! Both write the shared project policy and never commit it. Every question, filesystem read, and
//! write is injected, so the decisions here are exercised without a live Claude UI or Git checkout;
//! `register.tsx` supplies the real Claude Code bindings.

import { policyPath, readProjectPolicy, recordsAutomatically, serializeProjectPolicy, type PolicyFile, type ThreadMode } from './project-policy'
import { OFFLINE_CONTRACT_VERSION, commandErrorFromEnvelope, type ThreadContract } from './thread-commands'

/** A question could not be shown: this Claude has no interactive question API. */
export class InteractionUnavailable extends Error {}
/** The person dismissed the question. */
export class InteractionDismissed extends Error {}

export type AskOption = string | { label: string; description?: string }
export type AskOptions = readonly AskOption[] | {
  options: readonly AskOption[]; header?: string; multiSelect?: boolean
}

/** The interactive surface the wizard and onboarding speak through. */
export type Interaction = {
  /** Ask one question and answer the chosen or typed label; rejects only with `InteractionDismissed` or `InteractionUnavailable`. */
  ask(question: string, options: AskOptions): Promise<string>
  log(text: string, to?: 'transcript' | 'debug'): Promise<void>
}

/** One organization from `delta --json org list`. */
export type Organization = { id: string; name: string; current: boolean }

/** Everything the wizard and onboarding need from the host, injected for testability. */
export type SetupEnv = {
  /** The Git checkout root, or a rejection when the session is not inside one. */
  checkoutRoot(): Promise<string>
  /** The absolute Git common directory, shared by linked worktrees. */
  gitCommonDir(): Promise<string | undefined>
  /** The recording contract this CLI speaks, or undefined when it predates `thread contract`. */
  contract(): Promise<ThreadContract | undefined>
  /** Organizations for `thread create`, or a typed rejection when the CLI cannot list them. */
  organizations(): Promise<Organization[]>
  /** Read a policy file, or undefined when it does not exist. */
  readFile(path: string): Promise<string | undefined>
  /** Write a policy file; the wizard does not commit it. */
  writeFile(path: string, text: string): Promise<void>
  /** Whether this session's conversation is already shared with the organization. */
  sessionShared(): Promise<boolean>
  /** Start sharing this session with the organization, as `/delta share` does; false when it cannot start now. */
  shareSession(): Promise<boolean>
}

/** Validate the parsed body of `delta --json org list`, keeping the CLI's typed error envelope. */
export function organizationsFrom(result: any): Organization[] {
  const failure = commandErrorFromEnvelope(result?.error)
  if (failure) throw failure
  if (!Array.isArray(result?.organizations) ||
      !result.organizations.every((org: any) => typeof org?.id === 'string' && org.id &&
        typeof org.name === 'string' && typeof org.current === 'boolean'))
    throw new Error('Unexpected organization list; use matching CLI and plugin builds')
  return result.organizations.map((org: any) => ({ id: org.id, name: org.name, current: !!org.current }))
}

/** What the setup wizard did, for the command's answer and its tests. */
export type SetupOutcome = {
  status: 'wrote' | 'cancelled' | 'unavailable' | 'no-checkout' | 'needs-update' | 'failed'
  text: string
}

const MODE_NAMES: Record<ThreadMode, string> = { manual: 'Manual', private: 'Private upload', organization: 'Organization sharing' }
/** `$.ui.ask` takes at most four options; the rest of an organization list is reached by typing. */
const MAX_ORGANIZATION_OPTIONS = 4
const CANCELLED: SetupOutcome = { status: 'cancelled', text: 'Left the existing Delta settings untouched.' }

const UNAVAILABLE_NOTICE =
  'This Claude build cannot show /delta setup\'s questions. Update Claude Code, or edit .delta/settings.json at the checkout root by hand.'

/** What `/delta setup` answers a session with no interactive surface: it can never ask. */
export const HEADLESS_REFUSAL =
  '/delta setup needs an interactive Claude Code terminal or Desktop Code tab. Print mode and SDK sessions cannot answer its questions. Edit .delta/settings.json at the checkout root by hand instead.'
const UPDATE_NOTICE =
  'Automatic Delta uploads need a newer Delta: this CLI speaks recording contract ' +
  `versions up to ${OFFLINE_CONTRACT_VERSION - 1}, and automatic uploads need ${OFFLINE_CONTRACT_VERSION}. Update Delta, then run /delta setup again. ` +
  'Manual sharing and /delta join keep working as they do today.'

/** An organization's option label: its name, plus its id when another organization shares the name. */
function organizationLabel(organization: Organization, organizations: readonly Organization[]): string {
  const shared = organizations.some((other) => other !== organization && other.name.toLowerCase() === organization.name.toLowerCase())
  return shared ? `${organization.name} (${organization.id})` : organization.name
}

/**
 * The organization an answer names: an exact id, an offered label, or the single organization with
 * that name (case-insensitively). An unknown or ambiguous answer matches nothing, so the wizard asks
 * again.
 */
function matchOrganization(answer: string, organizations: readonly Organization[]): Organization | undefined {
  const text = answer.trim()
  const byId = organizations.find((organization) => organization.id === text)
  if (byId) return byId
  const byLabel = organizations.find((organization) => organizationLabel(organization, organizations) === text)
  if (byLabel) return byLabel
  const matches = organizations.filter((organization) => organization.name.toLowerCase() === text.toLowerCase())
  return matches.length === 1 ? matches[0] : undefined
}

/** Describe a repository's current policy for the wizard's first question. */
function currentPolicy(policy: PolicyFile['policy']): string {
  if (!policy.configured) return 'This repository has no Delta policy yet.'
  if (policy.mode === 'manual') return 'Currently: manual (only /delta share records anything).'
  return `Currently: ${MODE_NAMES[policy.mode]}${policy.organization ? ` (${policy.organization})` : ''}.`
}

/**
 * Run the interactive setup wizard. Every step is a question; dismissing any of them, or writing
 * nothing before the final confirmation, leaves the policy file exactly as it was.
 */
export async function runSetupWizard(env: SetupEnv, interaction: Interaction): Promise<SetupOutcome> {
  try { return await askAndWrite(env, interaction) }
  catch (error) {
    if (error instanceof InteractionUnavailable) return { status: 'unavailable', text: UNAVAILABLE_NOTICE }
    if (error instanceof InteractionDismissed) return CANCELLED
    throw error
  }
}

async function askAndWrite(env: SetupEnv, interaction: Interaction): Promise<SetupOutcome> {
  let root: string
  try { root = await env.checkoutRoot() }
  catch (error) { return { status: 'no-checkout', text: `/delta setup needs a Git checkout: ${String(error)}` } }
  const path = policyPath(root)
  let file: PolicyFile
  try { file = readProjectPolicy(await env.readFile(path)) }
  catch (error) { return { status: 'failed', text: `/delta setup could not read ${path}: ${String(error)}` } }

  if (file.malformed) {
    await interaction.log(`Delta could not read ${path}: ${file.policy.problem}. Its contents were left untouched.`, 'transcript')
    if (await interaction.ask(`Replace the unreadable Delta settings at ${path}?`, ['Replace it', 'Cancel']) !== 'Replace it') return CANCELLED
  }

  // A policy that records to an organization this account isn't in records nothing for it; say so
  // before asking, so the person can see why. An unreadable list just skips the warning.
  let listed: Organization[] | undefined
  if (recordsAutomatically(file.policy) && file.policy.organization) {
    try { listed = await env.organizations() } catch {}
    if (listed?.length && !listed.some((org) => org.id === file.policy.organization))
      await interaction.log(`This repository records to ${file.policy.organization}, which your Delta account isn't a member of, so its sessions aren't recorded for you. Choose an organization you're in to fix the file, or cancel to leave it unchanged.`, 'transcript')
  }

  const contract = await env.contract()
  const answer = await interaction.ask(
    `${currentPolicy(file.policy)} Delta records a session's conversation, tool input and output, ` +
    'thinking, and your checkout files. It applies to sessions started afterwards; this one is unchanged. ' +
    'How should this checkout record Claude Code sessions?',
    { options: Object.values(MODE_NAMES), header: 'Recording' })
  const mode = (Object.keys(MODE_NAMES) as ThreadMode[]).find((candidate) => MODE_NAMES[candidate] === answer)
  if (!mode) return CANCELLED

  let organization: Organization | undefined
  let target = ''
  if (mode !== 'manual') {
    if ((contract?.max ?? 0) < OFFLINE_CONTRACT_VERSION) {
      await interaction.log(UPDATE_NOTICE, 'transcript')
      return { status: 'needs-update', text: UPDATE_NOTICE }
    }
    let organizations: Organization[]
    try { organizations = listed ?? await env.organizations() }
    catch (error) { return { status: 'failed', text: `/delta setup could not list your Delta organizations: ${String(error)}` } }
    if (!organizations.length) return { status: 'failed', text: '/delta setup found no Delta organization. Sign in with `delta auth login` and try again.' }
    const current = organizations.find((org) => org.current) ?? organizations[0]!
    // Offer the current organization and up to three others; any organization is still reachable by
    // typing its exact name or id, and an unmatched or ambiguous answer asks again.
    const offered = [current, ...organizations.filter((org) => org !== current)].slice(0, MAX_ORGANIZATION_OPTIONS)
    if (organizations.length === 1) organization = current
    while (!organization) {
      organization = matchOrganization(await interaction.ask(
        'Which organization should this checkout upload to? Choose one, or type an exact organization name or id.',
        { options: offered.map((org) => organizationLabel(org, organizations)), header: 'Organization' }), organizations)
    }
    target = `, uploading to ${organizationLabel(organization, organizations)}`
  }

  const text = serializeProjectPolicy(file.document, mode, organization?.id)
  const question = `Write ${path} with recording set to ${MODE_NAMES[mode]}${target}? It is not committed.`
  if (await interaction.ask(question, ['Write it', 'Cancel']) !== 'Write it') return CANCELLED

  try { await env.writeFile(path, text) }
  catch (error) { return { status: 'failed', text: `Delta could not write ${path}: ${String(error)}` } }
  const wrote = `Wrote ${path}. Commit it to apply this policy to everyone who opens this repository with the plugin. New sessions then record automatically.`
  // The policy never applies to the session that wrote it, so offer to share this one now. The file
  // is already written, so declining or dismissing this question still reports the write.
  if (await env.sessionShared()) return { status: 'wrote', text: wrote }
  let share: string | undefined
  try { share = await interaction.ask('Share this session with your Delta organization now?', ['Share it', 'Not now']) }
  catch (error) { if (!(error instanceof InteractionDismissed || error instanceof InteractionUnavailable)) throw error }
  if (share !== 'Share it') return { status: 'wrote', text: `${wrote} This session is not shared; use /delta share to share it.` }
  return {
    status: 'wrote',
    text: await env.shareSession()
      ? `${wrote} Sharing this session now.`
      : `${wrote} This session could not start sharing now; use /delta share once Claude is idle.`,
  }
}

/** How an onboarding attempt ended, mostly for tests and the debug log. */
export type OnboardingOutcome = 'offered' | 'skipped' | 'unavailable'

/** What the startup hook already knows about the session that is starting and its checkout. */
export type OnboardingFlags = {
  root: string
  /** The checkout's policy file deliberately configures a mode, which suppresses the offer. */
  configured: boolean
  /** A new session, not a resume, compaction, or fork. */
  newSession: boolean
  joined: boolean
  joining: boolean
}

/** Where a repository's one-time onboarding offer is remembered. */
export type OnboardingStore = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

/**
 * Offer to set up automatic uploads once per repository, recording the offer before asking so two
 * sessions starting together cannot both show it. Linked worktrees share the marker through the
 * repository's Git common directory. An unavailable surface clears the marker again, so a session
 * that could not ask does not consume the offer; a dismissal does. A setup started from the offer
 * reports its outcome in the transcript, as `/delta setup` answers with it.
 */
export async function offerOnboarding(
  env: SetupEnv, interaction: Interaction, store: OnboardingStore, flags: OnboardingFlags,
): Promise<OnboardingOutcome> {
  if (flags.configured || flags.joined || flags.joining || !flags.newSession) return 'skipped'
  const key = `setup-offered:${await env.gitCommonDir() ?? flags.root}`
  if (await store.get(key)) return 'skipped'
  await store.set(key, true)
  let answer: string | undefined
  try { answer = await interaction.ask('Set up automatic Delta uploads for this repository?', ['Set it up', 'Not now']) }
  catch (error) {
    if (error instanceof InteractionUnavailable) {
      await store.set(key, false)
      return 'unavailable'
    }
  }
  if (answer !== 'Set it up') return 'offered'
  let text: string
  try {
    const outcome = await runSetupWizard(env, interaction)
    if (outcome.status === 'cancelled') return 'offered'
    text = outcome.text
  } catch (error) { text = `/delta setup failed: ${String(error)}` }
  await interaction.log(text, 'transcript')
  return 'offered'
}
