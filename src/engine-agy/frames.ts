/**
 * The Antigravity frame mapper.
 *
 * Antigravity's `stream-json` output is a family of `event`-tagged NDJSON
 * documents. Only one of them was verified (the probe's credential had expired
 * before any other could be emitted), but it happens to be the one that matters
 * most: the `result` envelope, which carries the run's whole outcome — status,
 * the answer text, the error, the conversation id and the token accounting:
 *
 * ```json
 * {"event":"result","result":{
 *   "conversation_id":"","status":"ERROR","response":"",
 *   "error":"authentication failed or timed out","duration_seconds":0,
 *   "num_turns":0,
 *   "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,
 *            "cache_read_tokens":0,"total_tokens":0}}}
 * ```
 *
 * So the mapper is written to be CORRECT under two worlds at once:
 *
 *  - if the CLI only ever emits `result` (or emits it last), the envelope's
 *    `response` is the answer and `status` is the verdict — complete and correct;
 *  - if it also streams assistant frames, those are mapped too, and the envelope
 *    still supplies the verdict and the usage.
 *
 * Anything unrecognized is dropped, which is what lets a protocol that grows new
 * events keep working. The one rule that is NOT best-effort: a `result` whose
 * status is not `OK`/`SUCCESS` is reported as a failure with the CLI's own
 * `error` text, because a run that failed must never read as an empty answer.
 *
 * @module dsh-loop-engine/engine-agy/frames
 */

import type { CliFrame } from '../driver-cli/frames.ts'

/** What the mapper learned about the run beyond its frames. */
export interface AgyRun {
  /** The conversation id the CLI reported, when it reported one. */
  conversationId: string | undefined
  /** Whether the envelope already carried the answer (so no streaming text is needed). */
  answered: boolean
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
 * Read liberally rather than exactly: the probe only ever observed `ERROR`, so
 * the success spelling is not pinned, and refusing an unknown-but-not-error
 * status would turn a working engine into a broken one. `ERROR`/`FAILED` are
 * failures; everything else is treated as a completed run whose text is what the
 * envelope says it is.
 * @param status - the envelope's status string.
 * @returns whether the run failed.
 */
function isFailureStatus(status: string | undefined): boolean {
  return status === 'ERROR' || status === 'FAILED'
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
  if (event === 'result') {
    mapResultEnvelope(envelope.result, accept, run)
    return []
  }
  // Assistant-ish frames, mapped defensively: the CLI may interleave partial
  // output, and recognizing the obvious spellings costs nothing while dropping
  // a frame the driver does not know costs the user their answer.
  mapBestEffortAssistant(envelope, accept)
  return []
}

/**
 * Map the `result` envelope.
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
  const usage = result.usage
  if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
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
  const status = typeof result.status === 'string' ? result.status : undefined
  if (isFailureStatus(status)) {
    const message = typeof result.error === 'string' && result.error !== ''
      ? result.error
      : typeof result.response === 'string' && result.response !== ''
        ? result.response
        : `agy ended the run with status ${status ?? 'unknown'}`
    accept({ kind: 'error', message })
    accept({ kind: 'settle' })
    return
  }
  const response = typeof result.response === 'string' ? result.response : ''
  if (response !== '' && !run.answered) {
    run.answered = true
    accept({ kind: 'text', text: response })
  }
  accept({ kind: 'settle' })
}

/**
 * Map a frame that looks like streamed assistant output.
 *
 * Deliberately shallow and additive: it recognizes the two obvious shapes (a
 * `text`/`content` string member, or a message whose `content` is a block list)
 * and otherwise does nothing. Any frame that already carries the answer through
 * the `result` envelope is left to that path, which is why this never overrides
 * {@link AgyRun.answered}.
 * @param envelope - the parsed document.
 * @param accept - frame sink.
 */
function mapBestEffortAssistant(envelope: Record<string, unknown>, accept: (frame: CliFrame) => void): void {
  const event = typeof envelope.event === 'string' ? envelope.event : ''
  if (!event.includes('assistant') && !event.includes('message') && !event.includes('delta')) return
  const direct = envelope.text ?? envelope.delta
  if (typeof direct === 'string' && direct !== '') {
    accept({ kind: 'text', text: direct })
    return
  }
  const content = envelope.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string' && record.text !== '') {
      accept({ kind: 'text', text: record.text })
    }
  }
}
