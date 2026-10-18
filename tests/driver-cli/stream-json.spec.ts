/**
 * The Claude-Code-compatible `stream-json` adapter.
 *
 * The dialect is shared by a whole family of CLIs (Claude Code itself and the
 * forks built on it, Qoder's among them), so this mapping is the single place
 * the family's frame shape is interpreted. The tests pin the four document kinds
 * that carry durable content, the two ways the dialect says "this run failed",
 * and — just as importantly — that everything else is DROPPED rather than
 * raising: a CLI that grows a new notification must not break a working driver.
 *
 * @module tests/driver-cli/stream-json
 */

import { describe, expect, it } from 'vitest'
import { mapStreamJsonDocument, streamJsonUsage } from '../../src/driver-cli/stream-json.ts'
import type { CliFrame } from '../../src/driver-cli/frames.ts'

/** Feed documents through the adapter and collect the frames. */
function collect(...documents: unknown[]): { frames: CliFrame[]; sessionId: string | undefined; error: string | undefined } {
  const frames: CliFrame[] = []
  const run = { sessionId: undefined as string | undefined, reportedError: undefined as string | undefined }
  for (const document of documents) {
    mapStreamJsonDocument(document, frame => frames.push(frame), run)
  }
  return { frames, sessionId: run.sessionId, error: run.reportedError }
}

describe('streamJsonUsage', () => {
  it('reads the snake_case spelling', () => {
    expect(streamJsonUsage({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3 }))
      .toEqual({ input: 5, output: 7, cacheRead: 3 })
  })

  it('reads the camelCase spelling a fork was seen to use', () => {
    expect(streamJsonUsage({ inputTokens: 5, outputTokens: 7 })).toEqual({ input: 5, output: 7 })
  })

  it('refuses a record with neither counter rather than reporting zeros', () => {
    // dsh distinguishes "reported zero" from "not reported"; a fabricated zero
    // would corrupt the accounting the compaction path reads.
    expect(streamJsonUsage({ cache_read_input_tokens: 3 })).toBeUndefined()
    expect(streamJsonUsage(null)).toBeUndefined()
    expect(streamJsonUsage([1, 2])).toBeUndefined()
  })

  it('defaults one missing counter to zero when the other is present', () => {
    expect(streamJsonUsage({ input_tokens: 5 })).toEqual({ input: 5, output: 0 })
  })
})

describe('mapStreamJsonDocument', () => {
  it('maps an assistant message’s text, reasoning and tool-use blocks', () => {
    const { frames } = collect({
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'PONG' },
          { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    })
    expect(frames).toEqual([
      { kind: 'usage', usage: { input: 1, output: 2 } },
      { kind: 'reasoning', text: 'let me think' },
      { kind: 'text', text: 'PONG' },
      { kind: 'tool-call', call: { id: 'call-1', name: 'Bash', arguments: { command: 'ls' } } },
    ])
  })

  it('maps a user message’s tool_result blocks onto tool-result frames', () => {
    const { frames } = collect({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file.txt', is_error: false }] },
    })
    expect(frames).toEqual([{ kind: 'tool-result', result: { id: 'call-1', text: 'file.txt', isError: false } }])
  })

  it('flattens a structured tool result rather than dropping it', () => {
    const { frames } = collect({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
    })
    expect(frames[0]).toEqual({ kind: 'tool-result', result: { id: 'c', text: 'a\n\nb', isError: false } })
  })

  it('ignores user text, which is the driver’s own outbound message', () => {
    const { frames } = collect({ type: 'user', message: { content: [{ type: 'text', text: 'hello' }] } })
    expect(frames).toEqual([])
  })

  it('reads the session id off any document that carries one', () => {
    expect(collect({ type: 'system', subtype: 'init', session_id: 'sess-9' }).sessionId).toBe('sess-9')
  })

  it('settles on the result document and reports usage', () => {
    const { frames } = collect({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'PONG',
      usage: { input_tokens: 3, output_tokens: 4 },
    })
    expect(frames).toEqual([
      { kind: 'usage', usage: { input: 3, output: 4 } },
      { kind: 'settle' },
    ])
  })

  it('reports a failure from the is_error flag', () => {
    const { frames, error } = collect({ type: 'result', is_error: true, result: 'boom' })
    expect(error).toBe('boom')
    expect(frames).toContainEqual({ kind: 'error', message: 'boom' })
  })

  it('reports a failure from a non-success subtype even when the flag is absent', () => {
    // A fork was observed to set only one of the two signals, so both are read.
    const { error } = collect({ type: 'result', subtype: 'error_during_execution' })
    expect(error).toBe('the engine ended the run with "error_during_execution"')
  })

  it('prefers the error member when the result text is empty', () => {
    const { error } = collect({ type: 'result', subtype: 'error', error: 'rate limited' })
    expect(error).toBe('rate limited')
  })

  it('drops hook, stream_event and unknown documents', () => {
    // The dialect interleaves plenty of documents with no durable place; a
    // protocol that grows another must not break a working driver.
    const { frames } = collect(
      { type: 'system', subtype: 'hook_started', hook_name: 'x' },
      { type: 'system', subtype: 'hook_progress', stdout: 'noise' },
      { type: 'stream_event', event: { delta: 'x' } },
      { type: 'artifacts_update', artifacts: [] },
      { type: 'something_new_in_a_later_release' },
      null,
      [1, 2],
      'a string',
    )
    expect(frames).toEqual([])
  })

  it('ignores an assistant document with nothing usable in it', () => {
    expect(collect({ type: 'assistant' }).frames).toEqual([])
    expect(collect({ type: 'assistant', message: 'not an object' }).frames).toEqual([])
    expect(collect({ type: 'assistant', message: { content: 'not a list' } }).frames).toEqual([])
  })

  it('skips unknown content-block kinds instead of stringifying them', () => {
    const { frames } = collect({
      type: 'assistant',
      message: { content: [{ type: 'image', source: {} }, { type: 'text', text: 'kept' }] },
    })
    expect(frames).toEqual([{ kind: 'text', text: 'kept' }])
  })

  it('skips empty text and thinking blocks', () => {
    const { frames } = collect({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '' }, { type: 'thinking', thinking: '' }] },
    })
    expect(frames).toEqual([])
  })

  it('skips a tool_use without an id or name', () => {
    const { frames } = collect({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'tool_use', id: 'x' }] },
    })
    expect(frames).toEqual([])
  })

  it('skips a tool_result with no matching call id', () => {
    const { frames } = collect({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })
    expect(frames).toEqual([])
  })
})

describe('malformed documents and blocks', () => {
  it('ignores a non-object document', () => {
    // A line that parses to `null`, a string or an array is not a document of
    // this protocol; it must be dropped rather than read as an empty one.
    expect(collect(null).frames).toEqual([])
    expect(collect('text').frames).toEqual([])
    expect(collect([{ type: 'assistant' }]).frames).toEqual([])
  })

  it('ignores a null or non-object block inside a content list', () => {
    // Anthropic-shaped content occasionally carries a placeholder; reading it
    // would put `undefined` in the transcript.
    const { frames } = collect({
      type: 'assistant',
      message: { role: 'assistant', content: [null, 'text', 7, { type: 'text', text: 'kept' }] },
    })
    expect(frames).toEqual([{ kind: 'text', text: 'kept' }])
  })

  it('ignores a non-object block inside a user content list', () => {
    const { frames } = collect({
      type: 'user',
      message: { content: [null, 7, { type: 'tool_result', tool_use_id: 'c', content: 'kept' }] },
    })
    expect(frames).toEqual([{ kind: 'tool-result', result: { id: 'c', text: 'kept', isError: false } }])
  })

  it('ignores an assistant or user document whose message is not an object', () => {
    expect(collect({ type: 'assistant', message: 'not a message' }).frames).toEqual([])
    expect(collect({ type: 'user', message: null }).frames).toEqual([])
  })

  it('ignores a content member that is not a list', () => {
    expect(collect({ type: 'assistant', message: { role: 'assistant', content: 'text' } }).frames).toEqual([])
    expect(collect({ type: 'user', message: { content: 'text' } }).frames).toEqual([])
  })

  it('reports a usage record carrying a cache counter', () => {
    // The cache counters are optional; when the engine reports them they must
    // reach the durable usage rather than being dropped as unknown fields.
    const { frames } = collect({
      type: 'assistant',
      message: {
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
        content: [],
      },
    })
    expect(frames).toEqual([{ kind: 'usage', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }])
  })

  it('ignores a usage record that reports no counter at all', () => {
    // Reporting zeros would be a fabricated measurement.
    const { frames } = collect({
      type: 'assistant',
      message: { role: 'assistant', usage: { cache_read_input_tokens: 9 }, content: [] },
    })
    expect(frames).toEqual([])
  })
})

describe('the remaining single arms', () => {
  it('defaults a missing input counter to zero while keeping the output', () => {
    const { frames } = collect({
      type: 'assistant',
      message: { role: 'assistant', usage: { output_tokens: 5 }, content: [] },
    })
    expect(frames).toEqual([{ kind: 'usage', usage: { input: 0, output: 5 } }])
  })

  it('accepts a document with no type member and still reads its session id', () => {
    // The session id lives on the envelope, not the payload: a document this
    // adapter does not recognise may still be the first place it sees one.
    const { sessionId } = collect({ session_id: 'sess-2', something: 'else' })
    expect(sessionId).toBe('sess-2')
  })

  it('prefers the error member over the generic wording when the result is empty', () => {
    const { error } = collect({ type: 'result', subtype: 'error', is_error: true, error: 'rate limited' })
    expect(error).toBe('rate limited')
  })

  it('falls back to the subtype when neither result nor error carries text', () => {
    const { error } = collect({ type: 'result', subtype: 'error_max_turns', is_error: true })
    expect(error).toContain('error_max_turns')
  })
})

describe('an empty error member', () => {
  it('falls through to the subtype wording when the error member is empty', () => {
    const { error } = collect({ type: 'result', subtype: 'error_during_execution', is_error: true, error: '' })
    expect(error).toContain('error_during_execution')
  })
})
