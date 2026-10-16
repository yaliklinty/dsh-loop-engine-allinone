/**
 * The Antigravity frame mapper — now written against REAL frames.
 *
 * The first version of this module was written while the probe host's Google
 * credential was expired, so only the `result` envelope could be observed and
 * the streaming vocabulary was left UNKNOWN. Re-probing after the host signed in
 * produced the whole protocol, and this is that protocol:
 *
 * ```
 * {"event":"init","conversation_id":"f3b26f65-…",
 *  "init":{"cwd":"…","tools":[…],"permission_mode":"request-review"}}
 *
 * {"event":"step_update","step_update":{
 *   "conversation_id":"…","step_index":1,"state":"ACTIVE",
 *   "step_type":"agent_response","text_delta":"Source code turns to byt"}}
 * {"event":"step_update","step_update":{
 *   "conversation_id":"…","step_index":1,"state":"DONE","step_type":"agent_response",
 *   "text_delta":"\n","duration_seconds":8.2,
 *   "usage":{"input_tokens":11707,"output_tokens":881,"thinking_tokens":864,
 *            "cache_read_tokens":0,"total_tokens":12588}}}
 *
 * {"event":"step_update","step_update":{
 *   "conversation_id":"…","step_index":2,"state":"ACTIVE","step_type":"tool",
 *   "tool_name":"run_command","tool_info":{"name":"run_command",
 *     "parameters":{"CommandLine":"echo hi"}}}}
 * {"event":"step_update","step_update":{
 *   "conversation_id":"…","step_index":2,"state":"DONE","step_type":"tool",
 *   "tool_name":"run_command","duration_seconds":0.75,
 *   "tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},
 *                "output":"hi\r\n"}}}
 *
 * {"event":"result","result":{"conversation_id":"…","status":"SUCCESS",
 *   "response":"Source code turns to bytes,\nSyntax checked and optimized,\nSilicon wakes up.\n",
 *   "duration_seconds":…,"num_turns":…,"usage":{…}}}
 * ```
 *
 * ## The four things this shapes
 *
 *  1. **`step_update` is the universal frame.** `step_type` says what the update
 *     is about — `user_input` (the echo of what we sent), `agent_response`
 *     (streamed answer text) or `tool` (an announced call, then its result) — and
 *     `state` says whether it is ACTIVE (in flight) or DONE (settled).
 *  2. **Answer text streams.** `text_delta` arrives incrementally on ACTIVE
 *     frames, and `result.response` repeats the concatenation at the end. Both
 *     are read; the envelope is emitted ONLY when no delta ever arrived, so the
 *     answer cannot land twice.
 *  3. **Tool calls need a synthesized id.** The protocol carries NO call id — a
 *     tool is identified by its `step_index` inside the conversation. dsh keys
 *     its pending-tool map by id and requires exactly one result per id, so the
 *     id is built as `<conversation_id>-tool-<step_index>`, which is unique
 *     because every driver run opens a fresh conversation (the driver never
 *     passes `--conversation`).
 *  4. **A tool result carries no error flag.** `tool_info` has `name`,
 *     `parameters` and `output`; a failure is read from an `error` member when
 *     one appears and otherwise treated as a success, because inventing a
 *     failure would be worse than reporting a successful-but-empty one.
 *
 * Anything unrecognized is dropped, which is what lets a protocol that grows a
 * new event keep working. The one rule that is NOT best-effort: a `result` whose
 * status is not success is reported as a failure carrying the CLI's own words,
 * because a failed run must never read as an empty answer.
 *
 * @module dsh-loop-engine/engine-agy/frames
 */

import type { CliFrame } from '../driver-cli/frames.ts'

/** What the mapper learned about the run beyond its frames. */
export interface AgyRun {
  /** The conversation id the CLI reported, when it reported one. */
  conversationId: string | undefined
  /**
   * Whether the streamed deltas already delivered the answer.
   *
   * The `result` envelope repeats the whole response, so this is what keeps the
   * answer from being committed twice.
   */
  answered: boolean
  /** The last `agent_response` step index a segment was opened for. */
  openStep: number | undefined
}

/** Create a fresh run accumulator. */
export function newAgyRun(): AgyRun {
  return { conversationId: undefined, answered: false, openStep: undefined }
}

/**
 * Read a numeric usage field, or undefined when absent or not a number.
 * @param record - the usage record.
 * @param key - the field name.
 * @returns the value, or undefined.
 */
function numberOf(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * Whether the envelope's status means the run succeeded.
 *
 * Read liberally rather than exactly: only `SUCCESS` and `ERROR` were observed,
 * so refusing an unknown-but-not-error status would turn a working engine into a
 * broken one. `ERROR`/`FAILED` are failures; everything else is a completed run
 * whose text is what the envelope says it is.
 * @param status - the envelope's status string.
 * @returns whether the run failed.
 */
function isFailureStatus(status: string | undefined): boolean {
  return status === 'ERROR' || status === 'FAILED'
}

/**
 * Project the CLI's usage record onto a frame.
 *
 * Antigravity reports the same shape in both places it appears (the DONE
 * `agent_response` update and the `result` envelope), so this is shared.
 * @param usage - the raw usage member.
 * @param accept - frame sink.
 */
function emitUsage(usage: unknown, accept: (frame: CliFrame) => void): void {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return
  const record = usage as Record<string, unknown>
  accept({
    kind: 'usage',
    usage: {
      input: numberOf(record, 'input_tokens') ?? 0,
      output: numberOf(record, 'output_tokens') ?? 0,
      ...numberOf(record, 'cache_read_tokens') === undefined
        ? {}
        : { cacheRead: numberOf(record, 'cache_read_tokens')! },
      ...numberOf(record, 'thinking_tokens') === undefined
        ? {}
        : { thinking: numberOf(record, 'thinking_tokens')! },
    },
  })
}

/**
 * Map one parsed Antigravity document to frames.
 * @param document - the parsed document.
 * @param accept - frame sink.
 * @param run - the run accumulator, updated in place.
 * @returns the frames to accept — empty, because this mapper pushes directly.
 */
export function mapAgyDocument(
  document: unknown,
  accept: (frame: CliFrame) => void,
  run: AgyRun,
): readonly CliFrame[] {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return []
  const envelope = document as Record<string, unknown>
  const event = typeof envelope.event === 'string' ? envelope.event : undefined
  switch (event) {
    case 'init':
      if (typeof envelope.conversation_id === 'string' && envelope.conversation_id !== '') {
        run.conversationId = envelope.conversation_id
      }
      return []
    case 'step_update':
      mapStepUpdate(envelope.step_update, accept, run)
      return []
    case 'result':
      mapResultEnvelope(envelope.result, accept, run)
      return []
    default:
      // An unknown event kind: dropped on purpose, so a protocol that grows one
      // keeps working.
      return []
  }
}

/**
 * Map one `step_update` payload.
 * @param value - the update payload.
 * @param accept - frame sink.
 * @param run - the run accumulator.
 */
function mapStepUpdate(value: unknown, accept: (frame: CliFrame) => void, run: AgyRun): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const update = value as Record<string, unknown>
  if (typeof update.conversation_id === 'string' && update.conversation_id !== '') {
    run.conversationId = update.conversation_id
  }
  const stepType = typeof update.step_type === 'string' ? update.step_type : undefined
  const state = typeof update.state === 'string' ? update.state : undefined
  const stepIndex = typeof update.step_index === 'number' ? update.step_index : -1
  switch (stepType) {
    case 'agent_response':
      mapAgentResponse(update, state, stepIndex, accept, run)
      return
    case 'tool':
      mapToolStep(update, state, stepIndex, accept, run)
      return
    case 'user_input':
      // The echo of what this driver sent: already in the durable log.
      return
    default:
      return
  }
}

/**
 * Map one streamed answer update.
 * @param update - the update payload.
 * @param state - `ACTIVE` or `DONE`.
 * @param stepIndex - the conversation-local step index.
 * @param accept - frame sink.
 * @param run - the run accumulator.
 */
function mapAgentResponse(
  update: Record<string, unknown>,
  state: string | undefined,
  stepIndex: number,
  accept: (frame: CliFrame) => void,
  run: AgyRun,
): void {
  const delta = typeof update.text_delta === 'string' ? update.text_delta : undefined
  if (delta !== undefined && delta !== '') {
    // One segment per `agent_response` step. The sink rotates the durable step at
    // a segment boundary, which is what puts a tool-using turn's two answer
    // segments in their own steps.
    //
    // Order matters: the DONE frame also carries a `text_delta` (the answer's
    // trailing newline in the captured run), and it belongs to the segment this
    // step opened. Closing the segment BEFORE folding that delta opened a second
    // one, which split a single answer across two durable steps.
    if (run.openStep !== stepIndex) {
      run.openStep = stepIndex
      accept({ kind: 'segment' })
    }
    run.answered = true
    accept({ kind: 'text', text: delta })
  }
  if (state === 'DONE') {
    // The segment this step opened is finished; the next `agent_response` step
    // (or the run's end) is what follows.
    run.openStep = undefined
    emitUsage(update.usage, accept)
  }
}

/**
 * Map one tool update — an announced call on ACTIVE, its result on DONE.
 * @param update - the update payload.
 * @param state - `ACTIVE` or `DONE`.
 * @param stepIndex - the conversation-local step index, which is the call's identity.
 * @param accept - frame sink.
 * @param run - the run accumulator.
 */
function mapToolStep(
  update: Record<string, unknown>,
  state: string | undefined,
  stepIndex: number,
  accept: (frame: CliFrame) => void,
  run: AgyRun,
): void {
  const info = update.tool_info
  const record = info !== null && typeof info === 'object' && !Array.isArray(info)
    ? info as Record<string, unknown>
    : {}
  const name = typeof update.tool_name === 'string' && update.tool_name !== ''
    ? update.tool_name
    : typeof record.name === 'string' && record.name !== ''
      ? record.name
      : 'tool'
  // Antigravity carries no call id. The conversation is opened fresh by every
  // driver run, so this pair is unique for the life of a session — which is
  // exactly what dsh's pending-tool map requires.
  const id = `${run.conversationId ?? 'agy'}-tool-${stepIndex}`
  if (state === 'DONE') {
    accept({
      kind: 'tool-result',
      result: {
        id,
        text: typeof record.output === 'string' ? record.output : '',
        // Read from an `error` member when one appears; never invented.
        isError: typeof record.error === 'string' && record.error !== '',
      },
    })
    emitUsage(update.usage, accept)
    return
  }
  accept({
    kind: 'tool-call',
    call: { id, name, arguments: record.parameters ?? {} },
  })
}

/**
 * Map the `result` envelope, which closes the run.
 * @param value - the envelope's `result` member.
 * @param accept - frame sink.
 * @param run - the run accumulator.
 */
function mapResultEnvelope(value: unknown, accept: (frame: CliFrame) => void, run: AgyRun): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    accept({ kind: 'error', message: 'agy ended the run without a result envelope' })
    accept({ kind: 'settle' })
    return
  }
  const result = value as Record<string, unknown>
  if (typeof result.conversation_id === 'string' && result.conversation_id !== '') {
    run.conversationId = result.conversation_id
  }
  emitUsage(result.usage, accept)
  const status = typeof result.status === 'string' ? result.status : undefined
  if (isFailureStatus(status)) {
    const message = typeof result.error === 'string' && result.error !== ''
      ? result.error
      : typeof result.response === 'string' && result.response !== ''
        ? result.response
        : `agy ended the run with status ${String(status)}`
    accept({ kind: 'error', message })
    accept({ kind: 'settle' })
    return
  }
  // The envelope repeats the whole answer. It is emitted ONLY when no delta
  // arrived, so a streamed turn does not duplicate its text.
  const response = typeof result.response === 'string' ? result.response : ''
  if (response !== '' && !run.answered) {
    run.answered = true
    accept({ kind: 'text', text: response })
  }
  accept({ kind: 'settle' })
}
