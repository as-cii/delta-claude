import { expect, test, tier } from 'claude-code/testing'
import { snapshotMessages } from './snapshot'

tier('user')

test('snapshot formats separate and combined bash rows without changing assistant text', () => {
  const input = { role: 'user' as const, content: [{ type: 'text', text: '<bash-input>ls</bash-input>' }] }
  const output = { role: 'user' as const, content: [
    { type: 'text', text: '<bash-stdout>Applications</bash-stdout><bash-stderr></bash-stderr>' },
  ] }
  const assistant = { ...input, role: 'assistant' as const }
  expect(snapshotMessages([input, output, { ...input, content: [...input.content, ...output.content] }, assistant]))
    .toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Ran `ls`' }] },
      { role: 'user', content: [{ type: 'text', text: '```\nApplications\n```' }] },
      { role: 'user', content: [{ type: 'text', text: 'Ran `ls`' }, { type: 'text', text: '```\nApplications\n```' }] },
      assistant,
    ])
  expect(input.content[0].text).toBe('<bash-input>ls</bash-input>')
})

test('snapshot export keeps the last 4096 messages in order without changing them', () => {
  const messages = Array.from({ length: 4100 }, (_, index) => ({
    role: 'user' as const, content: [{ type: 'text' as const, text: `message-${index}` }],
  }))
  const exported = snapshotMessages(messages)
  expect(exported).toHaveLength(4096)
  expect(exported[0]).toBe(messages[4])
  expect(exported.at(-1)).toBe(messages.at(-1))
  expect(exported).toEqual(messages.slice(4))
  expect(messages).toHaveLength(4100)
})

test('snapshot drops whole engine framing blocks and Delta context, not literal prompts or other content', () => {
  const framing = [
    ...['command-name', 'command-message', 'command-args', 'local-command-stdout',
      'local-command-stderr', 'local-command-caveat', 'system-reminder']
      .map((tag) => ` \n<${tag}>framing\nbody</${tag}>\n `),
    '<command-name>/delta</command-name>\n<command-message>delta</command-message>\n<command-args>share</command-args>',
    '[Delta] Ada: remote context',
  ].map((text) => ({ type: 'text' as const, text }))
  const kept = [
    { type: 'text', text: 'Explain <command-name> in this prompt.' },
    { type: 'text', text: 'A reminder: <system-reminder>example</system-reminder>' },
    { type: 'text', text: '<command-name>example</command-name> is a wrapper.' },
    { type: 'text', text: '<command-name>a</command-name> versus <command-name>b</command-name>' },
    { type: 'text', text: 'Mention [Delta] in prose.' },
    { type: 'image', source: { type: 'url', url: 'https://example.org/image.png' } },
    { type: 'tool_result', tool_use_id: 't1', content: 'result' },
  ]
  const assistant = { role: 'assistant' as const, content: framing }
  expect(snapshotMessages([
    { role: 'user', content: framing },
    { role: 'user', content: [framing[0], ...kept, framing[1]] },
    assistant,
  ])).toEqual([{ role: 'user', content: kept }, assistant])
})

test('snapshot drops the synthetic "Tool loaded." block only beside tool results', () => {
  const loaded = { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', tool_name: 'WebFetch' }] }
  const plain = { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't2', content: 'result' }] }
  const prompt = { role: 'user' as const, content: [{ type: 'text', text: 'Tool loaded.' }] }
  const exported = snapshotMessages([
    { role: 'user', content: [loaded, { type: 'text', text: 'Tool loaded.' }] },
    // Normalization merges a following user message, adding a newline to the marker.
    { role: 'user', content: [loaded, { type: 'text', text: 'Tool loaded.\n' }, { type: 'text', text: 'next' }] },
    plain,
    prompt,
  ])
  expect(exported).toEqual([
    { role: 'user', content: [loaded] },
    { role: 'user', content: [loaded, { type: 'text', text: 'next' }] },
    plain,
    prompt,
  ])
  expect(exported[2]).toBe(plain)
  expect(exported[3]).toBe(prompt)
})
