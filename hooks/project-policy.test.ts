import { describe, expect, test } from 'claude-code/testing'
import { readProjectPolicy, serializeProjectPolicy } from './project-policy'

describe('project policy', () => {
  test('each kind of file reads as its effective policy, and unusable ones record manually', () => {
    const problem = expect.any(String)
    const cases: [string | undefined, object, boolean?][] = [
      [undefined, { mode: 'manual', configured: false }],
      ['{}', { mode: 'manual', configured: false }],
      ['{"threads":{}}', { mode: 'manual', configured: false }],
      ['{"threads":{"mode":"manual"}}', { mode: 'manual', configured: true }],
      ['{"threads":{"mode":"organization","organization":"org-1"}}', { mode: 'organization', organization: 'org-1', configured: true }],
      ['{"threads":{"mode":"private"}}', { mode: 'manual', configured: false, problem }],
      ['{"threads":{"mode":"team"}}', { mode: 'manual', configured: false, problem }],
      ['{ not json', { mode: 'manual', configured: false, problem }, true],
    ]
    for (const [text, policy, malformed] of cases) {
      const file = readProjectPolicy(text)
      expect(file.policy).toEqual(policy)
      expect(file.malformed).toBe(malformed)
    }
  })

  test('serializing preserves unknown keys and round-trips through the reader', () => {
    const previous = { unrelated: { keep: [1, 2] }, threads: { future: 'x', mode: 'private', organization: 'org-1' } }
    const text = serializeProjectPolicy(previous, 'organization', 'org-2')
    expect(JSON.parse(text)).toEqual({
      unrelated: { keep: [1, 2] },
      threads: { future: 'x', mode: 'organization', organization: 'org-2' },
    })
    expect(readProjectPolicy(text).policy).toEqual({ mode: 'organization', organization: 'org-2', configured: true })
    // Switching back to manual drops the upload organization rather than leaving it implied.
    const manual = JSON.parse(serializeProjectPolicy(JSON.parse(text), 'manual'))
    expect(manual).toEqual({ unrelated: { keep: [1, 2] }, threads: { future: 'x', mode: 'manual' } })
  })
})
