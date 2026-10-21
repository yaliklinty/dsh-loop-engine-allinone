/**
 * ZCode's structured event stream: the mapping from `--output-format stream-json`
 * documents to dsh frames.
 *
 * The shapes below are trimmed captures from zcode 0.16.9 against a local
 * Anthropic-compatible mock: real text deltas, a real tool call, its result and
 * the terminal `turn.completed` envelope.
 *
 * @module tests/engine-zcode/frames
 */

import { describe, expect, it } from 'vitest'
import type { CliFrame } from '../../src/driver-cli/frames.ts'
import { mapZcodeDocument, newZcodeRun, zcodeUsage } from '../../src/engine-zcode/frames.ts'

/** Collect the frames of a sequence of documents. */
function collect(documents: readonly unknown[]): CliFrame[] {
  const frames: CliFrame[] = []
  const run = newZcodeRun()
  for (const document of documents) mapZcodeDocument(document, frame => frames.push(frame), run)
  return frames
}

/** One `model.streaming` event. */
const streaming = (payload: Record<string, unknown>): unknown => ({ type: 'model.streaming', payload })
/** One `tool.updated` event. */
const toolUpdate = (payload: Record<string, unknown>): unknown => ({ type: 'tool.updated', payload })

describe('ZCode text and reasoning', () => {
  it('maps text and reasoning deltas', () => {
    const frames = collect([
      streaming({ kind: 'text_delta', delta: 'Hello ' }),
      streaming({ kind: 'reasoning_delta', delta: 'thinking' }),
      streaming({ kind: 'text_delta', delta: 'world' }),
    ])
    expect(frames).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'text', text: 'world' },
    ])
  })

  it('emits the terminal response only when no delta streamed', () => {
    const streamed = collect([
      streaming({ kind: 'text_delta', delta: 'DONE' }),
      { type: 'turn.completed', payload: { response: 'DONE', resultType: 'success' } },
    ])
    expect(streamed.filter(frame => frame.kind === 'text')).toEqual([{ kind: 'text', text: 'DONE' }])
    const envelopeOnly = collect([
      { type: 'turn.completed', payload: { response: 'DONE', resultType: 'success' } },
    ])
    expect(envelopeOnly).toContainEqual({ kind: 'text', text: 'DONE' })
  })
})

describe('ZCode tool calls', () => {
  it('maps the tool_call delta to one tool-call and its result', () => {
    const frames = collect([
      streaming({ kind: 'tool_call', toolCallId: 'toolu_1', toolName: 'Bash', input: { command: 'echo TOOLPROBE' } }),
      toolUpdate({ kind: 'scheduled', toolCallId: 'toolu_1', toolName: 'Bash', input: { command: 'echo TOOLPROBE' } }),
      toolUpdate({ kind: 'started', toolCallId: 'toolu_1', toolName: 'Bash' }),
      toolUpdate({ kind: 'result', toolCallId: 'toolu_1', result: { success: true, content: 'TOOLPROBE' } }),
    ])
    // The scheduled frame repeats what the delta already announced; the sink
    // keys by id, and the mapper must not announce the same call twice.
    expect(frames.filter(frame => frame.kind === 'tool-call')).toEqual([{
      kind: 'tool-call',
      call: { id: 'toolu_1', name: 'Bash', arguments: { command: 'echo TOOLPROBE' } },
    }])
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'toolu_1', text: 'TOOLPROBE', isError: false },
    })
  })

  it('marks a failed result as an error and carries the engine’s text', () => {
    const frames = collect([
      streaming({ kind: 'tool_call', toolCallId: 'toolu_2', toolName: 'Bash', input: {} }),
      toolUpdate({ kind: 'error', toolCallId: 'toolu_2', error: 'permission denied' }),
    ])
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'toolu_2', text: 'permission denied', isError: true },
    })
  })
})

describe('ZCode usage and failure', () => {
  it('maps camelCase usage counters', () => {
    expect(zcodeUsage({ inputTokens: 20, outputTokens: 7, cacheReadTokens: 3, reasoningTokens: 2 }))
      .toEqual({ input: 20, output: 7, cacheRead: 3, thinking: 2 })
    expect(zcodeUsage({})).toBeUndefined()
  })

  it('reports a non-success turn as an error', () => {
    const frames = collect([
      { type: 'turn.completed', payload: { response: '', resultType: 'error', error: 'quota exceeded' } },
    ])
    expect(frames).toContainEqual({ kind: 'error', message: 'quota exceeded' })
  })
})

describe('ZCode stream edge cases', () => {
  it('ignores non-documents, unknown events and empty deltas', () => {
    expect(collect([null, 7, [], { type: 'session.updated' }])).toEqual([])
    expect(collect([
      streaming({ kind: 'text_delta', delta: '' }),
      streaming({ kind: 'reasoning_delta', delta: '' }),
      streaming({ kind: 'finish' }),
    ])).toEqual([])
  })

  it('records the session id and tolerates a missing payload', () => {
    const run = newZcodeRun()
    mapZcodeDocument({ type: 'session.updated', sessionId: 'sess_1' }, () => {}, run)
    mapZcodeDocument({ type: 'model.streaming' }, () => {}, run)
    expect(run.sessionId).toBe('sess_1')
  })

  it('synthesizes an id when the wire omits one, and announces a result-only call', () => {
    const frames = collect([
      toolUpdate({ kind: 'result', result: { success: true, content: 'TOOLPROBE' } }),
    ])
    expect(frames[0]).toMatchObject({ kind: 'tool-call', call: { name: 'tool', id: 'zcode-tool-1' } })
    expect(frames[1]).toEqual({
      kind: 'tool-result',
      result: { id: 'zcode-tool-1', text: 'TOOLPROBE', isError: false },
    })
  })

  it('maps a failed result and the progress status', () => {
    const frames = collect([
      streaming({ kind: 'tool_call', toolCallId: 'c1', toolName: 'Bash', input: { command: 'x' } }),
      toolUpdate({ kind: 'progress', toolCallId: 'c1' }),
      toolUpdate({ kind: 'result', toolCallId: 'c1', result: { success: false, content: 'denied' } }),
    ])
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'c1', text: 'denied', isError: true },
    })
  })

  it('uses the output field and a placeholder when a result carries no content', () => {
    const frames = collect([
      streaming({ kind: 'tool_call', toolCallId: 'c1', toolName: 'Bash', input: {} }),
      toolUpdate({ kind: 'result', toolCallId: 'c1', output: 'from-output' }),
      streaming({ kind: 'tool_call', toolCallId: 'c2', toolName: 'Bash', input: {} }),
      toolUpdate({ kind: 'result', toolCallId: 'c2', result: { success: true } }),
    ])
    expect(frames).toContainEqual({ kind: 'tool-result', result: { id: 'c1', text: 'from-output', isError: false } })
    expect(frames).toContainEqual({ kind: 'tool-result', result: { id: 'c2', text: '(no content)', isError: false } })
  })

  it('maps every usage counter and rejects non-usage values', () => {
    expect(zcodeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 }))
      .toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 5 })
    expect(zcodeUsage({ inputTokens: 1 })).toEqual({ input: 1, output: 0 })
    expect(zcodeUsage(null)).toBeUndefined()
    expect(zcodeUsage('x')).toBeUndefined()
  })

  it('falls back to the `result` envelope when `turn.completed` is absent', () => {
    const frames = collect([
      { type: 'result', sessionId: 's', response: 'DONE', usage: { inputTokens: 2, outputTokens: 1 }, error: 'warn' },
    ])
    expect(frames).toContainEqual({ kind: 'text', text: 'DONE' })
    expect(frames).toContainEqual({ kind: 'usage', usage: { input: 2, output: 1 } })
    expect(frames).toContainEqual({ kind: 'error', message: 'warn' })
  })

  it('reports a failed turn even without an error string', () => {
    const frames = collect([{ type: 'turn.completed', payload: { resultType: 'error' } }])
    expect(frames).toEqual([{ kind: 'error', message: 'ZCode turn ended with error' }])
  })
})

describe('ZCode malformed-but-tolerated frames', () => {
  it('maps output-only usage and rejects an unknown tool status', () => {
    expect(zcodeUsage({ outputTokens: 2 })).toEqual({ input: 0, output: 2 })
    expect(collect([toolUpdate({ kind: 'batch' }), toolUpdate({ kind: 'weird' })])).toEqual([])
  })

  it('uses the placeholder when an error frame carries no message', () => {
    const frames = collect([
      streaming({ kind: 'tool_call', toolCallId: 'c1', toolName: 'Bash', input: {} }),
      toolUpdate({ kind: 'error', toolCallId: 'c1' }),
    ])
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: 'c1', text: '(no content)', isError: true },
    })
  })

  it('handles a result envelope with no error and no response', () => {
    expect(collect([{ type: 'result', usage: { inputTokens: 1, outputTokens: 2 } }]))
      .toEqual([{ kind: 'usage', usage: { input: 1, output: 2 } }])
  })

  it('falls back to the resultType message when the error text is empty', () => {
    const frames = collect([{ type: 'turn.completed', payload: { resultType: 'error', error: '', response: '' } }])
    expect(frames).toEqual([{ kind: 'error', message: 'ZCode turn ended with error' }])
  })
})
