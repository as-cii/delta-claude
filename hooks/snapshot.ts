import type { ApiMessage } from 'claude-code'
import { bashMarkdown } from './bash'

const framingTags = 'command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder'
const framingBlocks = new RegExp(`<(${framingTags})>[\\s\\S]*?</\\1>`, 'g')

/** API snapshots lack doors, so only entire framing blocks can be identified safely. */
function framingText(text: string): boolean {
  if (/^\s*\[Delta\](?:\s|$)/.test(text)) return true
  const remainder = text.replace(framingBlocks, '')
  return remainder !== text && !remainder.trim()
}

/**
 * Normalization appends this block to a user message whose tool results load deferred tools.
 * Merging a following user message that starts with text adds one newline to it.
 */
const toolLoaded = /^Tool loaded\.\n?$/

/** Export only the latest bounded, normalized main conversation, preserving arrival order. */
export function snapshotMessages(messages: readonly ApiMessage[]): ApiMessage[] {
  return messages.slice(-4096).flatMap((message) => {
    if (message.role !== 'user') return [message]
    const results = message.content.some((block) => block.type === 'tool_result')
    const content = message.content.filter((block) => block.type !== 'text' ||
      typeof block.text !== 'string' || !(framingText(block.text) || results && toolLoaded.test(block.text)))
      .map((block) => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block
        const text = bashMarkdown(block.text)
        return text === block.text ? block : { ...block, text }
      })
    if (!content.length) return []
    return [content.length === message.content.length &&
      content.every((block, index) => block === message.content[index]) ? message : { ...message, content }]
  })
}
