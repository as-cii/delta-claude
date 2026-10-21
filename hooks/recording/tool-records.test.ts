import { describe, expect, test, tier } from 'claude-code/testing'
import { ToolRecords } from './tool-records'

tier('user')

describe('tool records', () => {
  for (const [first, second] of [['call', 'row'], ['row', 'call']] as const)
    test(`entries stay until both the call and its row are recorded (${first} first)`, () => {
      const records = remember('tool')
      records.settle('tool', first)
      // The other half still needs the stored result and turn.
      expect(records.structuredResults.get('tool')).toBeDefined()
      expect(records.toolResults.get('tool')).toBeDefined()
      expect(records.toolTurns.get('tool')).toBe(4)
      records.settle('tool', second)
      expect(records.size).toBe(0)
    })

  test('a completed turn keeps its unpaired tools for a late row, and the next completed turn releases them', () => {
    const records = new ToolRecords()
    // A refused tool has a row but no call hook; an interrupted one has a call but no row.
    remember('refused', records, 4)
    remember('interrupted', records, 4)
    remember('current', records, 7)
    remember('untracked', records, 'none')
    remember('running', records, 4)
    records.settle('refused', 'row')
    records.settle('interrupted', 'call')
    records.settle('current', 'call')
    records.settle('untracked', 'call')
    records.forgetUnpaired(4)
    // Turn 4 just completed: its late row must still find the turn and output, but a turn-less entry cannot be placed.
    expect(records.toolTurns.get('interrupted')).toBe(4)
    expect(records.structuredResults.has('interrupted')).toBe(true)
    expect(records.toolTurns.has('untracked')).toBe(false)
    records.settle('interrupted', 'row')
    expect(records.toolTurns.has('interrupted')).toBe(false)
    records.forgetUnpaired(7)
    expect([...records.toolTurns.keys()].sort()).toEqual(['current', 'running'])
    expect(records.toolResults.has('refused')).toBe(false)
    // A tool still running is never released, and its call settles it normally afterwards.
    records.settle('running', 'call')
    records.settle('running', 'row')
    expect(records.toolTurns.has('running')).toBe(false)
  })

  test('clearing releases everything, including pairing state, so a reused ID is not mistaken for settled', () => {
    const records = remember('tool')
    records.settle('tool', 'call')
    records.clear()
    expect(records.size).toBe(0)
    remember('tool', records)
    records.settle('tool', 'call')
    expect(records.size).toBeGreaterThan(0)
  })

})

function remember(id: string, records = new ToolRecords(), turn: number | 'none' = 4) {
  records.structuredResults.set(id, { sessionUpdate: 'tool_call_update', toolCallId: id, rawOutput: 'x'.repeat(1000) })
  records.toolResults.set(id, { type: 'tool_result', tool_use_id: id, content: 'x' })
  records.toolTurns.set(id, turn === 'none' ? undefined : turn)
  return records
}
