/**
 * Hermes' `--format stream-json` mapper.
 *
 * Payload shapes come from Hermes 0.21.4's own emitter
 * (`hermes_cli/stream_json.py`): `text`, `tool_use` with `input`, `tool_result`
 * with `output`, and the terminal `result` with `tokens`/`exit_code`.
 *
 * @module tests/engine-hermes/frames
 */

import { describe, expect, it } from 'vitest'
import type { CliFrame } from '../../src/driver-cli/frames.ts'
import { hermesUsage, mapHermesDocument, newHermesRun } from '../../src/engine-hermes/frames.ts'

/** Collect the frames of a sequence of documents. */
function collect(documents: readonly unknown[]): CliFrame[] {
  const frames: CliFrame[] = []
  const run = newHermesRun()
  for (const document of documents) mapHermesDocument(document, frame => frames.push(frame), run)
  return frames
}

describe('Hermes text and terminal envelope', () => {
  it('maps incremental text and avoids repeating the terminal text', () => {
    const frames = collect([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'result', exit_code: 0, text: 'Hello world', tokens: { input: 3, output: 2 } },
    ])
    expect(frames.filter(frame => frame.kind === 'text')).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
    ])
    expect(frames).toContainEqual({ kind: 'usage', usage: { input: 3, output: 2 } })
  })

  it('uses the terminal text when no delta streamed', () => {
    expect(collect([{ type: 'result', exit_code: 0, text: 'PONG', tokens: {} }]))
      .toContainEqual({ kind: 'text', text: 'PONG' })
  })

  it('reports a failed result as an error', () => {
    const frames = collect([{ type: 'result', exit_code: 1, text: '', error: 'no provider configured' }])
    expect(frames).toContainEqual({ kind: 'error', message: 'no provider configured' })
  })

  it('maps usage in Hermes’ token vocabulary', () => {
    expect(hermesUsage({ input: 1, output: 2, cache_read: 3, cache_write: 4 }))
      .toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
    expect(hermesUsage({})).toBeUndefined()
  })
})

describe('Hermes tool events', () => {
  it('maps tool_use and its tool_result', () => {
    const frames = collect([
      { type: 'tool_use', name: 'bash', tool_call_id: 'call_1', input: { command: 'echo TOOLPROBE' } },
      { type: 'tool_result', name: 'bash', tool_call_id: 'call_1', output: 'TOOLPROBE', is_error: false },
    ])
    expect(frames).toContainEqual({
      kind: 'tool-call',
      call: { id: 'call_1', name: 'bash', arguments: { command: 'echo TOOLPROBE' } },
    })
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'call_1', text: 'TOOLPROBE', isError: false },
    })
  })

  it('pairs an id-less result with the oldest pending call of that name', () => {
    const frames = collect([
      { type: 'tool_use', name: 'bash', input: { command: 'echo TOOLPROBE' } },
      { type: 'tool_result', name: 'bash', output: 'TOOLPROBE' },
    ])
    const call = frames.find(frame => frame.kind === 'tool-call') as { call: { id: string } }
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: call.call.id, text: 'TOOLPROBE', isError: false },
    })
  })

  it('reports an empty tool output with a visible placeholder', () => {
    const frames = collect([
      { type: 'tool_use', name: 'bash', tool_call_id: 'c1', input: {} },
      { type: 'tool_result', name: 'bash', tool_call_id: 'c1', output: '' },
    ])
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'c1', text: '(no content)', isError: false },
    })
  })
})

describe('Hermes stream edge cases', () => {
  it('ignores non-documents, system events and empty text', () => {
    expect(collect([null, 5, [], { type: 'system' }, { type: 'text' }, { type: 'text', text: '' }, { type: 'unknown' }]))
      .toEqual([])
  })

  it('records the session id', () => {
    const run = newHermesRun()
    mapHermesDocument({ type: 'system', session_id: '20261022_1' }, () => {}, run)
    expect(run.sessionId).toBe('20261022_1')
  })

  it('synthesizes a call id and pairs an unknown-name result with the oldest call', () => {
    const frames = collect([
      { type: 'tool_use', name: 'bash', input: {} },
      { type: 'tool_result', name: 'other', output: 'x' },
    ])
    const call = frames.find(frame => frame.kind === 'tool-call') as { call: { id: string } }
    expect(call.call.id).toBe('hermes-tool-1')
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'hermes-tool-1', text: 'x', isError: false },
    })
  })

  it('ignores a result with no pending call, and stringifies a non-string output', () => {
    expect(collect([{ type: 'tool_result', name: 'bash', output: 'x' }])).toEqual([])
    const frames = collect([
      { type: 'tool_use', name: 'bash', tool_call_id: 'c1', input: {} },
      { type: 'tool_result', name: 'bash', tool_call_id: 'c1', output: 42, is_error: true },
    ])
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'c1', text: '42', isError: true },
    })
  })

  it('maps every token counter spelling', () => {
    expect(hermesUsage({ input: 1, cache_read: 2 })).toEqual({ input: 1, output: 0, cacheRead: 2 })
    expect(hermesUsage({ output: 2, cache_write: 3 })).toEqual({ input: 0, output: 2, cacheWrite: 3 })
    expect(hermesUsage(null)).toBeUndefined()
  })

  it('reports a non-zero exit without an error string', () => {
    expect(collect([{ type: 'result', exit_code: 2, text: 'boom' }]))
      .toContainEqual({ kind: 'error', message: 'boom' })
    expect(collect([{ type: 'result', exit_code: 2, text: '' }]))
      .toContainEqual({ kind: 'error', message: 'hermes exited with code 2' })
  })

  it('does not repeat terminal text after a delta', () => {
    const frames = collect([
      { type: 'text', text: 'PONG' },
      { type: 'result', exit_code: 0, text: 'PONG' },
    ])
    expect(frames.filter(frame => frame.kind === 'text')).toHaveLength(1)
  })
})

describe('Hermes malformed-but-tolerated frames', () => {
  it('defaults a missing tool name and input', () => {
    expect(collect([{ type: 'tool_use' }])).toContainEqual({
      kind: 'tool-call',
      call: { id: 'hermes-tool-1', name: 'tool', arguments: {} },
    })
  })

  it('defaults a result name and stringifies a null output', () => {
    const frames = collect([
      { type: 'tool_use', name: 'bash', tool_call_id: 'c1', input: {} },
      { type: 'tool_result', tool_call_id: 'c1', output: null },
    ])
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'c1', text: '(no content)', isError: false },
    })
  })

  it('ignores a non-string result text and a result without exit_code', () => {
    expect(collect([{ type: 'result', text: 42, tokens: { input: 1, output: 1 } }]))
      .toContainEqual({ kind: 'usage', usage: { input: 1, output: 1 } })
  })
})
