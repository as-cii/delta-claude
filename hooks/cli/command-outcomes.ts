import { conversationWebLink } from '../watch/conversation'
import { commandErrorFromEnvelope, DeltaCommandError } from './thread-commands'
import { isJsonObject, isNonEmptyString, type JsonObject } from '../core/json'
import { samePath } from '../core/paths'
import type { ProcessRunResult } from 'claude-code'

/** Decode one short command result without assuming success from its exit code alone. */
export function checkResult(result: ProcessRunResult, name: string): JsonObject {
  if (result.isStdoutTruncated || result.isStderrTruncated)
    throw new Error(`${name}: Delta CLI output truncated; no acknowledgment assumed`)
  let data: unknown
  try { data = JSON.parse(result.stdout.trim()) }
  catch { data = undefined }
  // Every Delta CLI answer is one JSON object; anything else is not an answer this plugin can read.
  if (!isJsonObject(data))
    throw new Error(`${name}: expected JSON from a current Delta CLI; install matching Delta CLI and app builds (${result.stderr.trim() || `exit ${result.exitCode}`})`)
  if (result.exitCode !== 0 || data.error)
    throw commandErrorFromEnvelope(data.error, name) ??
      new DeltaCommandError('process_failed', `${name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return data
}

/** What `thread create` answers: the thread, and whether this call created it. */
export type CreationReceipt = { operation: 'created'; thread_id: string; created: boolean }
/** What `worktree attach` answers: the checkout's reference and directory. */
export type AttachmentReceipt = { operation: 'mounted'; reference: string; directory: string }
/** What `thread share` answers: the shared thread and its link. */
export type PublicationReceipt = { operation: 'shared'; thread_id: string; url: string }

/** Require an idempotent producer creation receipt before saving its thread identity. */
export function validateCreationReceipt(created: JsonObject): asserts created is JsonObject & CreationReceipt {
  if (created.operation !== 'created' || !isNonEmptyString(created.thread_id) ||
      typeof created.created !== 'boolean')
    throw new Error('Invalid thread creation receipt; retry the same session without resetting its outbox')
}

/** Require the requested checkout and a usable worktree reference. */
export function validateAttachmentReceipt(attached: JsonObject, directory: string): asserts attached is JsonObject & AttachmentReceipt {
  if (attached.operation !== 'mounted' || typeof attached.reference !== 'string' || !attached.reference.trim() ||
      typeof attached.directory !== 'string' || !samePath(attached.directory, directory))
    throw new Error('Invalid checkout attachment receipt; saved records remain queued')
}

/** Require a safe link to the exact thread being published. */
export function validatePublicationReceipt(
  shared: JsonObject, thread: string | undefined,
): asserts shared is JsonObject & PublicationReceipt {
  if (shared.operation !== 'shared' || shared.thread_id !== thread ||
      typeof shared.url !== 'string' || !conversationWebLink(shared.url))
    throw new Error('Invalid publication receipt; saved records remain queued')
}

/** Reconnecting backs off exponentially, capped at thirty seconds. */
export function reconnectDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
}
