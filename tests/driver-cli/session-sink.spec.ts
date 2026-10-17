/**
 * The shared session sink — the durable-log half of every CLI driver.
 *
 * This is the module worth testing hardest, because every invariant it holds is
 * one the session format enforces by REFUSING TO LOAD the log rather than by
 * raising at write time. A regression here does not fail a step; it produces a
 * session that cannot be reopened, and the user finds out later.
 *
 * The invariants pinned below:
 *
 *  1. **One tool result per call.** Session V4 deletes a call's pending entry on
 *     its first result, so a second write for the same id is refused on load.
 *     Engines really do report the same execution twice.
 *  2. **A result is preceded by the assistant message that carries its
 *     `tool-call` block.** An engine that runs a tool without streaming an
 *     assistant message first would otherwise leave the result orphaned.
 *  3. **A call is announced (a `tool/call` event) after the message that owns
 *     it**, so the log reads assistant/message → tool/call → tool/result.
 *  4. **A step is never closed while it still owes a result.** `closeStep`
 *     writes an explicit failure result for anything unsettled, because a
 *     `step/end` carrying an unresolved announcement is also a log V4 refuses.
 *  5. **A run that produced nothing is not a success.** An engine that settles
 *     without answering must read as a failure, not as an empty but fine turn.
 *
 * The session is a recorder rather than a real one: what is under test is the
 * ORDER and SHAPE of the events, and a fake makes both visible.
 *
 * @module tests/driver-cli/session-sink
 */

import { describe, expect, it } from 'vitest'
import { SessionSink, flattenToolResult, mapUsage, type SinkHost } from '../../src/driver-cli/session-sink.ts'
import type { CliFrame } from '../../src/driver-cli/frames.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { toolResultView } from '../helpers/harness-generation.ts'

/** One recorded append. */
interface Append {
  readonly type: string
  readonly data: Record<string, unknown>
  readonly surfaceOp: string | undefined
}

/** A session that records what it is asked to write. */
interface Recorder {
  readonly session: Session
  readonly appends: Append[]
  /** The event types, in write order. */
  types(): string[]
}

function recorder(): Recorder {
  const appends: Append[] = []
  const session = {
    append: (type: string, data: Record<string, unknown>, options?: { surfaceOp?: string }) => {
      // The sink hands over the exact data object, so the test can read the
      // durable shape back rather than a re-serialization of it.
      appends.push({ type, data, surfaceOp: options?.surfaceOp })
      return { seq: appends.length }
    },
    snapshotEvents: () => [],
    deriveMessages: () => [],
    header: { cwd: '/work' },
    requestHeader: () => undefined,
  } as unknown as Session
  return { session, appends, types: () => appends.map(entry => entry.type) }
}

/** The frames a sink host's own bookkeeping needs. */
function hostOf(
  rec: Recorder,
  onStepRotated: (step: number) => void = () => {},
  engine: SinkHost['engine'] = 'qoderclicn',
): SinkHost {
  return {
    session: rec.session,
    sessionId: 'session-1' as never,
    engine,
    provider: 'external',
    model: 'default',
    dispatch: { emit: () => {} } as never,
    onStepRotated,
  }
}

/** Feed frames into a fresh sink and report the position it ended on. */
function feed(rec: Recorder, frames: readonly CliFrame[], step = 1): { sink: SessionSink; position: { turn: number; step: number } } {
  const sink = new SessionSink(hostOf(rec))
  const position = { turn: 1, step }
  sink.beginRun()
  sink.beginStep()
  for (const frame of frames) sink.accept(frame, position)
  return { sink, position }
}

describe('the assistant-message lifecycle', () => {
  it('commits one durable message carrying the streamed text', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'segment' },
      { kind: 'text', text: 'PON' },
      { kind: 'text', text: 'G' },
    ])
    sink.finish(position)
    expect(rec.types()).toEqual(['assistant/message'])
    const message = rec.appends[0]!.data.message as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'text', text: 'PONG' }])
    expect(rec.appends[0]!.surfaceOp).toBe('append')
  })

  it('folds streamed reasoning into the message, ahead of the answer', () => {
    // Reasoning is not a separate durable event: it is a content block, and the
    // ordering (reasoning then text) matches what the in-process loop produces.
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'reasoning', text: 'thinking' }, { kind: 'text', text: 'answer' }])
    sink.finish(position)
    const message = rec.appends[0]!.data.message as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }])
  })

  it('attaches usage to the message that closes the run', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'text', text: 'x' },
      { kind: 'usage', usage: { input: 3, output: 4 } },
    ])
    sink.finish(position)
    expect(rec.appends[0]!.data.usage).toEqual({ inputTokens: 3, outputTokens: 4 })
  })

  it('carries an empty timed stream for a whole-message engine', () => {
    // A text-protocol engine has no deltas, so its message carries no frames —
    // and must still be a well-formed assistant/message.
    const rec = recorder()
    const { sink, position } = feed(rec, [])
    sink.commitWholeMessage('PONG\n', undefined, position)
    sink.finish(position)
    expect(rec.appends[0]!.data.stream).toEqual([])
  })

  it('folds separately reported reasoning into a whole message', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [])
    sink.commitWholeMessage('answer', 'reasoning', position)
    const message = rec.appends[0]!.data.message as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'reasoning', text: 'reasoning' }, { type: 'text', text: 'answer' }])
  })

  it('preserves streamed reasoning the protocol omitted from its final message', () => {
    // Some providers emit only streaming thinking deltas; losing them would drop
    // content the model produced.
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'reasoning', text: 'streamed thought' }])
    sink.commitBlocks([{ type: 'text', text: 'answer' }], position)
    const message = rec.appends[0]!.data.message as { content: unknown[] }
    expect(message.content).toEqual([{ type: 'reasoning', text: 'streamed thought' }, { type: 'text', text: 'answer' }])
  })
})

describe('the tool-call / tool-result pairing', () => {
  it('writes assistant/message → tool/call → tool/result for one call', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'text', text: 'let me look' },
      { kind: 'tool-call', call: { id: 'c1', name: 'Read', arguments: { path: '/a' } } },
      { kind: 'tool-result', result: { id: 'c1', text: 'contents', isError: false } },
    ])
    sink.finish(position)
    expect(rec.types()).toEqual(['assistant/message', 'tool/call', 'tool/result'])
  })

  it('synthesizes the owning assistant message when a result arrives first', () => {
    // Invariant 2: an engine that runs a tool without streaming an assistant
    // message must not leave the result orphaned.
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: { command: 'ls' } } },
      { kind: 'tool-result', result: { id: 'c1', text: 'ok', isError: false } },
    ])
    sink.finish(position)
    expect(rec.types()).toEqual(['assistant/message', 'tool/call', 'tool/result'])
    const message = rec.appends[0]!.data.message as { content: unknown[] }
    // `qoderclicn` has no projection row, so the engine's own spelling is kept.
    expect(message.content).toEqual([{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{"command":"ls"}' }])
  })

  it('keeps text and a tool call in ONE assistant message, because they are one model turn', () => {
    // Splitting them would make a replay show the model answering twice for one
    // turn.
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'text', text: 'let me look' },
      { kind: 'tool-call', call: { id: 'c1', name: 'Read', arguments: { path: '/a' } } },
      { kind: 'tool-result', result: { id: 'c1', text: 'contents', isError: false } },
    ])
    sink.finish(position)
    expect(rec.types()).toEqual(['assistant/message', 'tool/call', 'tool/result'])
    const content = (rec.appends[0]!.data.message as { content: { type: string }[] }).content
    expect(content.map(block => block.type)).toEqual(['text', 'tool-call'])
  })

  it('projects the engine’s tool name onto dsh’s vocabulary when the engine has a row', () => {
    const rec = recorder()
    const sink = new SessionSink(hostOf(rec, () => {}, 'claude-code'))
    const position = { turn: 1, step: 1 }
    sink.beginRun()
    sink.beginStep()
    sink.accept({ kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: { command: 'ls' } } }, position)
    sink.finish(position)
    const block = (rec.appends[0]!.data.message as { content: { name?: string }[] }).content[0]!
    expect(block.name).toBe('bash')
  })

  it('writes exactly ONE result for a call the engine reported twice', () => {
    // Invariant 1, and the reason it matters: a second result for one id is a log
    // V4 refuses to load.
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'tool-call', call: { id: 'c1', name: 'Read', arguments: {} } },
      { kind: 'tool-result', result: { id: 'c1', text: 'first', isError: false } },
      { kind: 'tool-result', result: { id: 'c1', text: 'second', isError: false } },
    ])
    sink.finish(position)
    expect(rec.types().filter(type => type === 'tool/result')).toHaveLength(1)
  })

  it('announces a call only once even when the engine repeats it', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'tool-call', call: { id: 'c1', name: 'Read', arguments: {} } },
      { kind: 'tool-call', call: { id: 'c1', name: 'Read', arguments: {} } },
    ])
    sink.finish(position)
    expect(rec.types().filter(type => type === 'tool/call')).toHaveLength(1)
    const message = rec.appends[0]!.data.message as { content: unknown[] }
    expect(message.content.filter(block => (block as { type?: string }).type === 'tool-call')).toHaveLength(1)
  })

  it('keeps the projected name and arguments byte-identical in the block and the event', () => {
    // Session V4 pairs the block and the event by id and refuses a log whose two
    // sides disagree, so normalizing twice would be a latent corruption.
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'tool-call', call: { id: 'c1', name: 'Write', arguments: { file_path: '/a', content: 'x' } } },
      { kind: 'tool-result', result: { id: 'c1', text: 'ok', isError: false } },
    ])
    sink.finish(position)
    const block = (rec.appends[0]!.data.message as { content: { type: string; name?: string; arguments?: string }[] })
      .content.find(entry => entry.type === 'tool-call')!
    const event = rec.appends.find(entry => entry.type === 'tool/call')!
    expect(event.data.name).toBe(block.name)
    expect(event.data.arguments).toBe(block.arguments)
  })

  it('carries the error flag through to the durable result', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } },
      { kind: 'tool-result', result: { id: 'c1', text: 'boom', isError: true } },
    ])
    sink.finish(position)
    const result = rec.appends.find(entry => entry.type === 'tool/result')!
    expect(toolResultView(result.data.message).isError).toBe(true)
  })

  it('writes a placeholder for an empty result, because a block with no text is not renderable', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } },
      { kind: 'tool-result', result: { id: 'c1', text: '', isError: false } },
    ])
    sink.finish(position)
    const result = rec.appends.find(entry => entry.type === 'tool/result')!
    const content = toolResultView(result.data.message).content as { text: string }[]
    expect(content[0]!.text).toBe('(no content)')
  })

  it('JSON-encodes arguments the engine handed over as a value', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'tool-call', call: { id: 'c1', name: 'X', arguments: undefined } }])
    sink.finish(position)
    const event = rec.appends.find(entry => entry.type === 'tool/call')!
    expect(event.data.arguments).toBe('{}')
  })

  it('passes an engine with no vocabulary row through unprojected', () => {
    // `qoderclicn` has no projection table, so its names are its own; an
    // unknown engine must degrade rather than guess.
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'tool-call', call: { id: 'c1', name: 'SomeTool', arguments: {} } }])
    sink.finish(position)
    const block = (rec.appends[0]!.data.message as { content: { name?: string }[] }).content[0]!
    expect(block.name).toBe('SomeTool')
  })
})

describe('step rotation', () => {
  it('rotates to the next step when a settled segment is followed by new content', () => {
    const rec = recorder()
    const rotations: number[] = []
    const sink = new SessionSink(hostOf(rec, step => { rotations.push(step) }))
    const position = { turn: 1, step: 1 }
    sink.beginRun()
    sink.beginStep()
    sink.accept({ kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } }, position)
    sink.accept({ kind: 'tool-result', result: { id: 'c1', text: 'ok', isError: false } }, position)
    // New assistant content after a settled result is the NEXT step.
    sink.accept({ kind: 'segment' }, position)
    expect(rotations).toEqual([2])
    expect(position.step).toBe(2)
  })

  it('does NOT rotate while the step still owes a result', () => {
    // Rotating here would strand the call in a step that can never resolve it,
    // which is itself a log V4 refuses.
    const rec = recorder()
    const rotations: number[] = []
    const sink = new SessionSink(hostOf(rec, step => { rotations.push(step) }))
    const position = { turn: 1, step: 1 }
    sink.beginRun()
    sink.beginStep()
    sink.accept({ kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } }, position)
    sink.accept({ kind: 'segment' }, position)
    expect(rotations).toEqual([])
    expect(position.step).toBe(1)
  })

  it('closes the step it is leaving', () => {
    const rec = recorder()
    const sink = new SessionSink(hostOf(rec))
    const position = { turn: 1, step: 1 }
    sink.beginRun()
    sink.beginStep()
    sink.accept({ kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } }, position)
    sink.accept({ kind: 'tool-result', result: { id: 'c1', text: 'ok', isError: false } }, position)
    sink.accept({ kind: 'segment' }, position)
    expect(rec.types()).toContain('step/end')
  })
})

describe('closing a step honestly', () => {
  it('writes a failure result for a call the engine never resolved', () => {
    // Invariant 4: a `step/end` carrying an unresolved announcement will not load.
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } }])
    sink.closeStep(position)
    const results = rec.appends.filter(entry => entry.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(toolResultView(results[0]!.data.message).isError).toBe(true)
    expect(rec.types().at(-1)).toBe('step/end')
  })

  it('does not double-close a step whose calls all resolved', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } },
      { kind: 'tool-result', result: { id: 'c1', text: 'ok', isError: false } },
    ])
    sink.closeStep(position)
    expect(rec.types().filter(type => type === 'tool/result')).toHaveLength(1)
    expect(rec.types().filter(type => type === 'step/end')).toHaveLength(1)
  })
})

describe('finish: the run verdict', () => {
  it('reports a completed run that answered', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'text', text: 'PONG' }])
    expect(sink.finish(position)).toEqual({ kind: 'completed' })
  })

  it('reports a run that produced nothing as a failure, not an empty success', () => {
    // Invariant 5, and the shape of the silent-degradation bug this plugin
    // exists not to ship.
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'settle' }])
    expect(sink.finish(position)).toEqual({ kind: 'failed', message: 'the engine ended the run without producing a reply' })
  })

  it('lets the engine’s own verdict outrank a committed message', () => {
    // An engine can settle cleanly with every turn failed AND print something;
    // reporting that as success would hand the user a broken turn.
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'text', text: 'partial' },
      { kind: 'error', message: 'rate limited' },
    ])
    expect(sink.finish(position)).toEqual({ kind: 'failed', message: 'rate limited' })
  })

  it('keeps the LAST verdict, so a retrying engine that recovers succeeds', () => {
    // An engine that retries emits one errored attempt per try; only the verdict
    // still standing when the stream ends is a failure.
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'error', message: 'attempt 1 failed' },
      { kind: 'segment' },
      { kind: 'text', text: 'recovered' },
    ])
    expect(sink.finish(position)).toEqual({ kind: 'completed' })
  })

  it('resets the run verdict between runs', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'error', message: 'boom' }])
    expect(sink.runFailure).toBe('boom')
    sink.beginRun()
    expect(sink.runFailure).toBeUndefined()
  })
})

describe('beginStep', () => {
  it('clears the per-step bookkeeping so a new step owes nothing', () => {
    const rec = recorder()
    const { sink, position } = feed(rec, [{ kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } }])
    // A call is owed a result only once its owning message has been committed —
    // that is what announces it. Committing happens at a boundary, not on
    // arrival, so the run is finished first.
    sink.finish(position)
    expect(sink.pendingCalls).toHaveLength(1)
    sink.beginStep()
    expect(sink.pendingCalls).toHaveLength(0)
  })

  it('remembers which calls were settled, so a repeat across steps is still dropped', () => {
    // Call ids are unique for the life of a session, so retaining the marks only
    // widens duplicate suppression — it can never hide a legitimate result.
    const rec = recorder()
    const { sink, position } = feed(rec, [
      { kind: 'tool-call', call: { id: 'c1', name: 'Bash', arguments: {} } },
      { kind: 'tool-result', result: { id: 'c1', text: 'ok', isError: false } },
    ])
    sink.beginStep()
    sink.accept({ kind: 'tool-result', result: { id: 'c1', text: 'again', isError: false } }, position)
    expect(rec.types().filter(type => type === 'tool/result')).toHaveLength(1)
  })
})

describe('mapUsage', () => {
  it('omits what the engine did not report', () => {
    expect(mapUsage({ input: 1, output: 2 })).toEqual({ inputTokens: 1, outputTokens: 2 })
  })

  it('carries cache and reasoning counters when reported', () => {
    expect(mapUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 5 }))
      .toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 })
  })
})

describe('flattenToolResult', () => {
  it('passes a string through', () => {
    expect(flattenToolResult('text')).toBe('text')
  })

  it('joins a block list, reading each block’s text', () => {
    expect(flattenToolResult([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\n\nb')
  })

  it('JSON-encodes a block it cannot read, rather than dropping it', () => {
    // A structured result stays inspectable in the transcript instead of
    // vanishing.
    expect(flattenToolResult([{ type: 'image', source: { data: 'x' } }])).toBe('{"type":"image","source":{"data":"x"}}')
    expect(flattenToolResult([{ type: 'image', a: 1 }, { type: 'text', text: 'b' }]))
      .toBe('{"type":"image","a":1}' + String.fromCharCode(10, 10) + 'b')
  })

  it('reads a wrapper object’s content member', () => {
    expect(flattenToolResult({ content: 'inner' })).toBe('inner')
    expect(flattenToolResult({ content: [{ type: 'text', text: 'inner' }] })).toBe('inner')
  })

  it('answers empty for null and undefined', () => {
    expect(flattenToolResult(null)).toBe('')
    expect(flattenToolResult(undefined)).toBe('')
  })

  it('JSON-encodes a bare value', () => {
    expect(flattenToolResult(42)).toBe('42')
  })

  it('skips an empty segment rather than emitting a blank line', () => {
    expect(flattenToolResult([{ type: 'text', text: '' }, { type: 'text', text: 'b' }])).toBe('b')
  })
})
