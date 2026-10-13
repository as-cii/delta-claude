import { expect, test, type Plugin } from 'claude-code/testing'

// See session-append-repro.md for standalone setup. Failures are intentional evidence.
const doors = ['prompt', 'command', 'response', 'tool-result', 'tool-message',
  'delivery', 'attachment', 'hook-context', 'note', 'compaction', 'notice'] as const

for (const door of doors) {
  const message = door === 'response'
    ? { type: 'assistant' as const, role: 'assistant' as const, content: [{ type: 'text', text: 'reply' }] }
    : door === 'tool-result' || door === 'tool-message'
      ? { type: 'user' as const, role: 'user' as const,
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }] }
      : { type: 'user' as const, role: 'user' as const, content: [{ type: 'text', text: 'prompt' }] }
  const row = { door, origin: door === 'note'
    ? { kind: 'plugin' as const, name: 'append-answer' }
    : { kind: 'engine' as const }, uuid: `row-${door}`, message }
  for (const mode of ['stored', 'next', 'deny'] as const) {
    test(`${door}: test hook returns ${mode}`, async ($, on) => {
      on('session.append', ($, e, next) => mode === 'next' ? next(e)
        : mode === 'deny' ? { deny: 'repro refusal' } : { uuid: e.uuid, message: e.message })
      const result = await $.session.append(row)
      if (mode === 'deny') expect(result).toEqual({ deny: 'repro refusal' })
    })
  }
}

const answeringPlugin: Plugin = {
  name: 'append-answer',
  register(on) {
    on('session.append', ($, e) => ({ uuid: e.uuid, message: e.message }))
    on('command.run', { command: 'append-repro' }, async ($, e) => {
      const result = await $.session.append({
        message: { type: 'user', content: [{ type: 'text', text: e.args }] },
      })
      return { text: JSON.stringify(result) }
    })
  },
}
test('inline plugin returns stored row for prompt', { plugins: [answeringPlugin] }, async ($) => {
  await $.session.append({
    door: 'prompt', origin: { kind: 'composer' }, uuid: 'inline-prompt',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hello' }] },
  })
})

for (const mode of ['stored', 'next', 'deny'] as const) {
  test(`plugin-owned note: test hook returns ${mode}`, { plugins: [answeringPlugin] }, async ($, on) => {
    let calls = 0
    on('session.append', ($, e, next) => {
      calls++
      expect(e.door).toBe('note')
      expect(e.origin.kind).toBe('plugin')
      return mode === 'next' ? next(e)
        : mode === 'deny' ? { deny: 'repro refusal' } : { uuid: e.uuid, message: e.message }
    })
    try {
      const result = await $.command.run({
        command: 'append-repro', args: mode, origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 80 },
      })
      expect(result.text).toBe(JSON.stringify({ deny: 'repro refusal' }))
    } catch (error) {
      throw new Error(`test append hook calls: ${calls}; ${String(error)}`)
    }
  })
}
