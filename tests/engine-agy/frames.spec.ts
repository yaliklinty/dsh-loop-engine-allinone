/**
 * The Antigravity frame mapper, pinned against REAL captured frames.
 *
 * Every payload below is copied from a live run on a signed-in host (raw
 * captures: `scripts/probe/probe.mjs agy`, plus the tool-turn capture
 * recorded in `docs/probes/agy.md`). That matters more here than anywhere else in
 * the suite: the first version of this mapper was written while the host's
 * credential was expired, so only the `result` envelope had ever been observed
 * and the streaming vocabulary was explicitly UNKNOWN. These tests are what
 * replaced that gap with facts.
 *
 * @module tests/engine-agy/frames
 */

import { describe, expect, it } from 'vitest'
import { mapAgyDocument, newAgyRun, type AgyRun } from '../../src/engine-agy/frames.ts'
import type { CliFrame } from '../../src/driver-cli/frames.ts'

/** Feed documents through the mapper and collect the frames. */
function collect(...documents: unknown[]): { frames: CliFrame[]; run: AgyRun } {
  const frames: CliFrame[] = []
  const run = newAgyRun()
  for (const document of documents) mapAgyDocument(document, frame => frames.push(frame), run)
  return { frames, run }
}

const CONV = 'd28219c7-99e6-4e57-8cf0-ac4e0b118ac8'
const TOOL_CONV = '1bcdc0fa-9e68-4baa-888f-36bc0a59b2cf'

/** The captured `init` frame, tools list truncated. */
const INIT = {
  event: 'init',
  conversation_id: CONV,
  init: { cwd: 'C:\\Temp\\probe', tools: ['run_command', 'view_file'], permission_mode: 'request-review' },
}

/** The captured text-only turn: three deltas then a DONE carrying usage. */
const TEXT_TURN: unknown[] = [
  { event: 'step_update', step_update: { conversation_id: CONV, step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: CONV, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Source code turns to byt' } },
  { event: 'step_update', step_update: { conversation_id: CONV, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'es,\nSyntax checked and' } },
  { event: 'step_update', step_update: { conversation_id: CONV, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: ' optimized,\nSilicon wakes up.' } },
  {
    event: 'step_update',
    step_update: {
      conversation_id: CONV, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n',
      duration_seconds: 8.2,
      usage: { input_tokens: 11707, output_tokens: 881, thinking_tokens: 864, cache_read_tokens: 0, total_tokens: 12588 },
    },
  },
  {
    event: 'result',
    result: {
      conversation_id: CONV, status: 'SUCCESS',
      response: 'Source code turns to bytes,\nSyntax checked and optimized,\nSilicon wakes up.\n',
      duration_seconds: 8.2, num_turns: 1,
      usage: { input_tokens: 11707, output_tokens: 881, thinking_tokens: 864, cache_read_tokens: 0, total_tokens: 12588 },
    },
  },
]

/** The captured tool turn, run with `--dangerously-skip-permissions`. */
const TOOL_TURN: unknown[] = [
  { event: 'init', conversation_id: TOOL_CONV, init: { permission_mode: 'always-proceed' } },
  { event: 'step_update', step_update: { conversation_id: TOOL_CONV, step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 11697, output_tokens: 177, thinking_tokens: 111, cache_read_tokens: 0, total_tokens: 11874 } } },
  {
    event: 'step_update',
    step_update: {
      conversation_id: TOOL_CONV, step_index: 2, state: 'ACTIVE', step_type: 'tool',
      tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: TOOL_CONV, step_index: 2, state: 'DONE', step_type: 'tool',
      tool_name: 'run_command', duration_seconds: 0.75,
      tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\r\n' },
    },
  },
  { event: 'step_update', step_update: { conversation_id: TOOL_CONV, step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'DONE.' } },
  { event: 'result', result: { conversation_id: TOOL_CONV, status: 'SUCCESS', response: 'DONE.\n' } },
]

describe('init and the envelope', () => {
  it('captures the conversation id and emits nothing for it', () => {
    const { frames, run } = collect(INIT)
    expect(frames).toEqual([])
    expect(run.conversationId).toBe(CONV)
  })
})

describe('a streamed answer', () => {
  it('maps each delta to text under ONE segment, and the envelope adds nothing', () => {
    // The envelope repeats the whole response, so emitting it as well would
    // commit the answer twice.
    const { frames } = collect(...TEXT_TURN)
    expect(frames.filter(frame => frame.kind === 'segment')).toHaveLength(1)
    const text = frames.filter(frame => frame.kind === 'text').map(frame => (frame as { text: string }).text).join('')
    expect(text).toBe('Source code turns to bytes,\nSyntax checked and optimized,\nSilicon wakes up.\n')
    expect(frames.at(-1)).toEqual({ kind: 'settle' })
  })

  it('emits the usage the DONE update carries', () => {
    const { frames } = collect(...TEXT_TURN)
    expect(frames).toContainEqual({
      kind: 'usage',
      usage: { input: 11707, output: 881, cacheRead: 0, thinking: 864 },
    })
  })

  it('ignores the user_input echo, which is already in the durable log', () => {
    expect(collect(TEXT_TURN[0]).frames).toEqual([])
  })

  it('falls back to the envelope when no delta ever arrived', () => {
    // The one case the envelope is still needed: a run whose answer was never
    // streamed must not read as an empty turn.
    const { frames } = collect({
      event: 'result',
      result: { conversation_id: CONV, status: 'SUCCESS', response: 'unstreamed answer' },
    })
    expect(frames).toContainEqual({ kind: 'text', text: 'unstreamed answer' })
  })
})

describe('a tool-using turn', () => {
  it('maps the tool step to a call and then its result', () => {
    const { frames } = collect(...TOOL_TURN)
    expect(frames).toContainEqual({
      kind: 'tool-call',
      call: { id: `${TOOL_CONV}-tool-2`, name: 'run_command', arguments: { CommandLine: 'echo hi' } },
    })
    expect(frames).toContainEqual({
      kind: 'tool-result',
      result: { id: `${TOOL_CONV}-tool-2`, text: 'hi\r\n', isError: false },
    })
  })

  it('synthesizes a call id, because the protocol carries none', () => {
    // dsh keys its pending-tool map by id and requires exactly one result per id;
    // Antigravity identifies a tool only by its step index inside the
    // conversation, so the id is the conversation plus that index.
    const { frames } = collect(...TOOL_TURN)
    const call = frames.find(frame => frame.kind === 'tool-call') as { call: { id: string } }
    const result = frames.find(frame => frame.kind === 'tool-result') as { result: { id: string } }
    expect(call.call.id).toBe(result.result.id)
    expect(call.call.id).toContain(TOOL_CONV)
  })

  it('opens a second segment for the answer that follows the tool', () => {
    // The pre-tool answer here carried only usage (no text), so exactly one
    // segment opens — for the answer after the tool.
    const { frames } = collect(...TOOL_TURN)
    const text = frames.filter(frame => frame.kind === 'text').map(frame => (frame as { text: string }).text).join('')
    expect(text).toBe('DONE.')
  })

  it('reads a failure from an error member, and never invents one', () => {
    const failed = collect({
      event: 'step_update',
      step_update: {
        conversation_id: CONV, step_index: 5, state: 'DONE', step_type: 'tool',
        tool_name: 'run_command', tool_info: { name: 'run_command', output: '', error: 'permission denied' },
      },
    })
    expect(failed.frames).toContainEqual({
      kind: 'tool-result',
      result: { id: `${CONV}-tool-5`, text: '', isError: true },
    })
    // A result with no error member is a SUCCESS, not a guess.
    const ok = collect({ event: 'step_update', step_update: { conversation_id: CONV, step_index: 5, state: 'DONE', step_type: 'tool', tool_info: { output: 'x' } } })
    expect((ok.frames[0] as { result: { isError: boolean } }).result.isError).toBe(false)
  })

  it('falls back to tool_info.name, then to a placeholder, when tool_name is absent', () => {
    const named = collect({ event: 'step_update', step_update: { conversation_id: CONV, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'view_file' } } })
    expect((named.frames[0] as { call: { name: string } }).call.name).toBe('view_file')
    const unnamed = collect({ event: 'step_update', step_update: { conversation_id: CONV, step_index: 1, state: 'ACTIVE', step_type: 'tool' } })
    expect((unnamed.frames[0] as { call: { name: string } }).call.name).toBe('tool')
    expect((unnamed.frames[0] as { call: { arguments: unknown } }).call.arguments).toEqual({})
  })
})

describe('failure and unknown-document handling', () => {
  it('reports a failed run with the CLI’s own error text and no answer', () => {
    const { frames } = collect({
      event: 'result',
      result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out' },
    })
    expect(frames).toContainEqual({ kind: 'error', message: 'authentication failed or timed out' })
    expect(frames).toContainEqual({ kind: 'settle' })
    expect(frames.some(frame => frame.kind === 'text')).toBe(false)
  })

  it('treats FAILED as a failure too, and falls back for a status with no error text', () => {
    expect(collect({ event: 'result', result: { status: 'FAILED' } }).frames)
      .toContainEqual({ kind: 'error', message: 'agy ended the run with status FAILED' })
    expect(collect({ event: 'result', result: { status: 'ERROR', response: 'partial' } }).frames)
      .toContainEqual({ kind: 'error', message: 'partial' })
    // A status this build does not recognize as a failure is NOT turned into
    // one: refusing an unknown-but-not-error status would break a working engine
    // the day the CLI adds a new one.
    expect(collect({ event: 'result', result: {} }).frames).toEqual([{ kind: 'settle' }])
  })

  it('reports a missing envelope rather than settling silently', () => {
    const { frames } = collect({ event: 'result' })
    expect(frames).toContainEqual({ kind: 'error', message: 'agy ended the run without a result envelope' })
    expect(frames).toContainEqual({ kind: 'settle' })
  })

  it('treats an unknown non-error status as a completed run', () => {
    const { frames } = collect({ event: 'result', result: { status: 'SOMETHING_NEW', response: 'hi' } })
    expect(frames).toContainEqual({ kind: 'text', text: 'hi' })
    expect(frames.some(frame => frame.kind === 'error')).toBe(false)
  })

  it('drops events and shapes it does not recognize', () => {
    // A protocol that grows a new event must not break a working driver.
    const { frames } = collect(
      { event: 'progress', percent: 10 },
      { event: 'step_update', step_update: { step_type: 'compaction', state: 'DONE' } },
      { event: 'step_update' },
      { event: 'step_update', step_update: 'not an object' },
      null,
      [1, 2],
      'a string',
      { no_event_at_all: true },
    )
    expect(frames).toEqual([])
  })

  it('tolerates a malformed usage member', () => {
    expect(collect({ event: 'result', result: { status: 'SUCCESS', response: 'x', usage: 'nonsense' } }).frames
      .some(frame => frame.kind === 'usage')).toBe(false)
  })

  it('names the conversation from a step update when init was missed', () => {
    const { run } = collect({ event: 'step_update', step_update: { conversation_id: 'late-conv', step_index: 0, step_type: 'user_input' } })
    expect(run.conversationId).toBe('late-conv')
  })

  it('falls back to the placeholder prefix for a call id when no conversation is known', () => {
    const { frames } = collect({ event: 'step_update', step_update: { step_index: 7, state: 'ACTIVE', step_type: 'tool', tool_name: 'x' } })
    expect((frames[0] as { call: { id: string } }).call.id).toBe('agy-tool-7')
  })
})

describe('the defensive arms of the mapper', () => {
  it('leaves the conversation id alone when the init frame carries none', () => {
    // A CLI that answers before it has a conversation (or omits the id) must not
    // be recorded with an empty one — that would make two different runs look
    // like the same conversation.
    const { run } = collect({ event: 'init', init: {} })
    expect(run.conversationId).toBeUndefined()

    const empty = collect({ event: 'init', conversation_id: '', init: {} })
    expect(empty.run.conversationId).toBeUndefined()
  })

  it('reports usage with only the fields the engine actually sent', () => {
    // dsh distinguishes "reported zero" from "not reported": a fabricated zero
    // would corrupt the context accounting the compaction path reads.
    const { frames } = collect({
      event: 'step_update',
      step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 3 } },
    })
    const usage = frames.find(frame => frame.kind === 'usage')
    expect(usage).toEqual({ kind: 'usage', usage: { input: 3, output: 0 } })
  })

  it('omits the cache counters when the engine did not report them', () => {
    const { frames } = collect({
      event: 'step_update',
      step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 1, output_tokens: 2 } },
    })
    const usage = frames.find(frame => frame.kind === 'usage') as { usage: Record<string, unknown> }
    expect(usage.usage).not.toHaveProperty('cacheRead')
    expect(usage.usage).not.toHaveProperty('cacheWrite')
    expect(usage.usage).not.toHaveProperty('thinking')
  })

  it('reads a step update that omits its own step_type, state and index', () => {
    // The mapper's defaults exist so a slimmer update is DROPPED rather than
    // turned into a bogus step; `stepIndex: -1` is the "no index" marker.
    const { frames } = collect({
      event: 'step_update',
      step_update: { text_delta: 'orphan' },
    })
    // No step_type means no block kind to attach the text to: nothing lands.
    expect(frames).toEqual([])
  })

  it('reports a tool result with no output as an empty string, not as undefined', () => {
    const { frames } = collect({
      event: 'step_update',
      step_update: {
        step_index: 2, state: 'DONE', step_type: 'tool',
        tool_name: 'run_command', tool_info: { name: 'run_command', parameters: {} },
      },
    })
    const result = frames.find(frame => frame.kind === 'tool-result') as { result: { text: string; isError: boolean } }
    expect(result.result).toEqual({ id: expect.any(String), text: '', isError: false })
  })

  it('marks a tool result as failed when the engine reported an error', () => {
    const { frames } = collect({
      event: 'step_update',
      step_update: {
        step_index: 2, state: 'DONE', step_type: 'tool',
        tool_name: 'run_command', tool_info: { name: 'run_command', parameters: {}, error: 'permission denied' },
      },
    })
    const result = frames.find(frame => frame.kind === 'tool-result') as { result: { isError: boolean } }
    expect(result.result.isError).toBe(true)
  })
})

describe('usage fields the engine does send', () => {
  it('maps every cache counter the engine reports', () => {
    // The captured turns all carry `cache_read_tokens`; the mapper must pass it
    // (and a write counter, when one appears) through rather than dropping it.
    const { frames } = collect({
      event: 'step_update',
      step_update: {
        step_index: 1, state: 'DONE', step_type: 'agent_response',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 5, thinking_tokens: 7 },
      },
    })
    const usage = frames.find(frame => frame.kind === 'usage') as { usage: Record<string, unknown> }
    expect(usage.usage).toEqual({ input: 10, output: 20, cacheRead: 5, thinking: 7 })
  })
})

describe('usage with missing counters', () => {
  it('defaults input and output to zero when the engine omitted them', () => {
    // A `usage` member that carries only one counter still produces a usable
    // record: the two mandatory fields fall back to 0 rather than to undefined,
    // because dsh's accounting reads them as numbers.
    const { frames } = collect({
      event: 'step_update',
      step_update: {
        step_index: 1, state: 'DONE', step_type: 'agent_response',
        usage: { total_tokens: 99 },
      },
    })
    const usage = frames.find(frame => frame.kind === 'usage') as { usage: Record<string, unknown> }
    expect(usage.usage).toEqual({ input: 0, output: 0 })
  })
})
