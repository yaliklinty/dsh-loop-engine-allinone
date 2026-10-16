/**
 * The Antigravity frame mapper.
 *
 * The probe host's Google credential had expired, so only the `result` envelope
 * could be captured. The mapper is therefore written to be correct under two
 * worlds at once — "only the envelope arrives" and "assistant frames arrive too"
 * — and these tests pin both, because the alternative (assuming streaming frames
 * exist) would ship a driver that silently answers nothing on a signed-in host.
 *
 * @module tests/engine-agy/frames
 */

import { describe, expect, it } from 'vitest'
import { mapAgyDocument, type AgyRun } from '../../src/engine-agy/frames.ts'
import type { CliFrame } from '../../src/driver-cli/frames.ts'

/** Feed documents through the mapper and collect the frames. */
function collect(...documents: unknown[]): { frames: CliFrame[]; run: AgyRun } {
  const frames: CliFrame[] = []
  const run: AgyRun = { conversationId: undefined, answered: false }
  for (const document of documents) mapAgyDocument(document, frame => frames.push(frame), run)
  return { frames, run }
}

/** The exact envelope the probe captured, with the failure swapped for success. */
const SUCCESS = {
  event: 'result',
  result: {
    conversation_id: 'conv-1',
    status: 'OK',
    response: 'PONG',
    error: '',
    duration_seconds: 1,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 4, total_tokens: 12 },
  },
}

/** The exact envelope the probe captured (verbatim, pre-auth-failure). */
const AUTH_FAILURE = {
  event: 'result',
  result: {
    conversation_id: '',
    status: 'ERROR',
    response: '',
    error: 'authentication failed or timed out',
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  },
}

describe('mapAgyDocument', () => {
  it('reads the answer and the accounting out of the result envelope', () => {
    // This is the path that must work on a signed-in host even if no other frame
    // shape was ever verified.
    const { frames, run } = collect(SUCCESS)
    expect(frames).toEqual([
      { kind: 'usage', usage: { input: 10, output: 2, cacheRead: 4, thinking: 1 } },
      { kind: 'text', text: 'PONG' },
      { kind: 'settle' },
    ])
    expect(run.conversationId).toBe('conv-1')
    expect(run.answered).toBe(true)
  })

  it('reports a failed run with the CLI’s own error text', () => {
    const { frames } = collect(AUTH_FAILURE)
    expect(frames).toContainEqual({ kind: 'error', message: 'authentication failed or timed out' })
    expect(frames).toContainEqual({ kind: 'settle' })
    // Nothing was committed as an answer: a failed run must never read as an
    // empty but successful turn.
    expect(frames.some(frame => frame.kind === 'text')).toBe(false)
  })

  it('treats a FAILED status as a failure too', () => {
    const { frames } = collect({ event: 'result', result: { status: 'FAILED', error: 'nope' } })
    expect(frames).toContainEqual({ kind: 'error', message: 'nope' })
  })

  it('falls back to the response text, then to a synthesized line, for a failure with no error', () => {
    expect(collect({ event: 'result', result: { status: 'ERROR', response: 'partial' } }).frames)
      .toContainEqual({ kind: 'error', message: 'partial' })
    expect(collect({ event: 'result', result: { status: 'ERROR' } }).frames)
      .toContainEqual({ kind: 'error', message: 'agy ended the run with status ERROR' })
    expect(collect({ event: 'result', result: { status: 'ERROR' } }).frames)
      .toContainEqual({ kind: 'error', message: 'agy ended the run with status ERROR' })
  })

  it('treats an unknown non-error status as a completed run', () => {
    // Read liberally on purpose: the probe only ever observed ERROR, so refusing
    // an unrecognized status would turn a working engine into a broken one.
    const { frames } = collect({ event: 'result', result: { status: 'SUCCESS', response: 'hi' } })
    expect(frames).toContainEqual({ kind: 'text', text: 'hi' })
    expect(frames.some(frame => frame.kind === 'error')).toBe(false)
  })

  it('reports a missing envelope rather than settling silently', () => {
    const { frames } = collect({ event: 'result' })
    expect(frames).toContainEqual({ kind: 'error', message: 'agy ended the run without a result envelope' })
    expect(frames).toContainEqual({ kind: 'settle' })
  })

  it('accepts assistant-ish frames so a streaming host still lands its text', () => {
    const { frames } = collect(
      { event: 'assistant_message', content: [{ type: 'text', text: 'streamed' }] },
      { event: 'assistant_delta', delta: ' more' },
    )
    expect(frames).toEqual([{ kind: 'text', text: 'streamed' }, { kind: 'text', text: ' more' }])
  })

  it('lets the envelope supply the answer even after streaming frames', () => {
    const { frames } = collect({ event: 'assistant_message', text: 'partial' }, SUCCESS)
    // The streamed text and the envelope's text both land; the envelope settles.
    expect(frames.filter(frame => frame.kind === 'text')).toHaveLength(2)
    expect(frames.at(-1)).toEqual({ kind: 'settle' })
  })

  it('drops everything it does not recognize', () => {
    const { frames } = collect(
      { event: 'progress', percent: 10 },
      { event: 'telemetry', x: 1 },
      null,
      [1, 2],
      'a string',
      { no_event_at_all: true },
    )
    expect(frames).toEqual([])
  })

  it('omits a usage field the CLI did not report', () => {
    const { frames } = collect({ event: 'result', result: { status: 'OK', response: 'x', usage: { input_tokens: 1, output_tokens: 1 } } })
    expect(frames[0]).toEqual({ kind: 'usage', usage: { input: 1, output: 1 } })
  })

  it('tolerates a malformed usage member', () => {
    const { frames } = collect({ event: 'result', result: { status: 'OK', response: 'x', usage: 'nonsense' } })
    expect(frames.some(frame => frame.kind === 'usage')).toBe(false)
  })

  it('ignores a conversation id it cannot use', () => {
    expect(collect({ event: 'result', result: { status: 'OK', response: 'x', conversation_id: '' } }).run.conversationId)
      .toBeUndefined()
  })
})
