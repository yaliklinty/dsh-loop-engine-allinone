/**
 * ZCode's `--output-format stream-json` event mapper.
 *
 * The one-shot `-p` surface has two renderings: plain text (the answer only)
 * and a newline-delimited event stream. The desktop app consumes the structured
 * form, and the CLI exposes it under a flag the help does not advertise
 * (`--output-format stream-json`); this module maps that stream, so ZCode's tool
 * calls and streaming text reach the durable log instead of vanishing into a
 * final printed answer.
 *
 * Event shapes measured against zcode 0.16.9 (the bundled `zcode.cjs`, talking
 * to a local Anthropic-compatible mock):
 *
 * ```
 * {"type":"model.streaming","payload":{"kind":"text_delta","delta":"…"}}
 * {"type":"model.streaming","payload":{"kind":"reasoning_delta","delta":"…"}}
 * {"type":"model.streaming","payload":{"kind":"tool_call","toolCallId":"toolu_1",
 *   "toolName":"Bash","input":{"command":"echo TOOLPROBE"}}}
 * {"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":"toolu_1",
 *   "toolName":"Bash","input":{…}}}
 * {"type":"tool.updated","payload":{"kind":"result","toolCallId":"toolu_1",
 *   "result":{"success":true,"content":"TOOLPROBE",…}}}
 * {"type":"turn.completed","payload":{"response":"DONE","resultType":"success",
 *   "usage":{"inputTokens":20,"outputTokens":7,…}}}
 * ```
 *
 * The event stream carries the same `toolCallId` on every stage, so pairing is
 * trivial. `turn.completed.response` repeats the streamed text; it is emitted
 * only when no `text_delta` arrived, so the answer cannot land twice.
 *
 * @module dsh-loop-engine-allinone/engine-zcode/frames
 */

import type { CliFrame, CliUsage } from '../driver-cli/frames.ts'
import { flattenToolResult } from '../driver-cli/flatten.ts'

/** What the mapper learned about the run beyond its frames. */
export interface ZcodeRun {
  /** Session id the CLI reported, when it reported one. */
  sessionId: string | undefined
  /** Whether any `text_delta` was emitted (the final response then is a repeat). */
  textSeen: boolean
  /** Tool call ids already announced. */
  readonly announced: Set<string>
  /** Whether a terminal `turn.completed` was seen. */
  completed: boolean
  /** Fallback id counter for a frame that omits `toolCallId`. */
  synthetic: number
}

/** Create a fresh run accumulator. */
export function newZcodeRun(): ZcodeRun {
  return { sessionId: undefined, textSeen: false, announced: new Set(), completed: false, synthetic: 0 }
}

/** Read a plain object, or undefined. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a non-empty string, or undefined. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Map ZCode's camelCase usage record to the shared shape. */
export function zcodeUsage(usage: unknown): CliUsage | undefined {
  const record = recordOf(usage)
  if (record === undefined) return undefined
  const input = typeof record.inputTokens === 'number' ? record.inputTokens : undefined
  const output = typeof record.outputTokens === 'number' ? record.outputTokens : undefined
  if (input === undefined && output === undefined) return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...typeof record.cacheReadTokens === 'number' ? { cacheRead: record.cacheReadTokens } : {},
    ...typeof record.cacheWriteTokens === 'number' ? { cacheWrite: record.cacheWriteTokens } : {},
    ...typeof record.reasoningTokens === 'number' ? { thinking: record.reasoningTokens } : {},
  }
}

/**
 * Map one parsed ZCode document to frames.
 * @param document - the parsed JSON line.
 * @param accept - frame sink.
 * @param run - the run accumulator, updated in place.
 * @returns always empty; frames are pushed directly.
 */
export function mapZcodeDocument(
  document: unknown,
  accept: (frame: CliFrame) => void,
  run: ZcodeRun,
): readonly CliFrame[] {
  const event = recordOf(document)
  if (event === undefined) return []
  const sessionId = textOf(event.sessionId)
  if (sessionId !== undefined) run.sessionId = sessionId
  const type = textOf(event.type)
  const payload = recordOf(event.payload) ?? {}

  if (type === 'model.streaming') {
    const kind = textOf(payload.kind)
    const delta = textOf(payload.delta)
    if (kind === 'text_delta' && delta !== undefined) {
      run.textSeen = true
      accept({ kind: 'text', text: delta })
    } else if (kind === 'reasoning_delta' && delta !== undefined) {
      accept({ kind: 'reasoning', text: delta })
    } else if (kind === 'tool_call') {
      announce(accept, run, payload)
    }
    return []
  }

  if (type === 'tool.updated') {
    const kind = textOf(payload.kind)
    if (kind === 'scheduled' || kind === 'started' || kind === 'progress') {
      announce(accept, run, payload)
      return []
    }
    if (kind === 'result' || kind === 'error') {
      const id = idOf(run, payload)
      if (!run.announced.has(id)) announce(accept, run, payload, id)
      const success = recordOf(payload.result)?.success
      const isError = kind === 'error' || success === false
      const text = isError
        ? flattenToolResult(payload.error ?? recordOf(payload.result)?.content ?? '')
        : flattenToolResult(recordOf(payload.result)?.content ?? payload.output ?? '')
      accept({ kind: 'tool-result', result: { id, text: text === '' ? '(no content)' : text, isError } })
    }
    return []
  }

  if (type === 'turn.completed') {
    run.completed = true
    emitUsage(payload.usage, accept)
    const response = textOf(payload.response)
    if (!run.textSeen && response !== undefined) accept({ kind: 'text', text: response })
    const resultType = textOf(payload.resultType)
    if (resultType !== undefined && resultType !== 'success') {
      const message = flattenToolResult(payload.error ?? response ?? `ZCode turn ended with ${resultType}`)
      accept({ kind: 'error', message: message === '' ? `ZCode turn ended with ${resultType}` : message })
    }
    return []
  }

  // `result` repeats the turn envelope after `turn.completed`; only use it when
  // the terminal event was absent (an older build or a stream cut short).
  if (type === 'result' && !run.completed) {
    // The `result` envelope is flat (top-level `response`/`usage`), unlike the
    // `turn.completed` event whose fields sit under `payload`.
    emitUsage(event.usage, accept)
    const response = textOf(event.response)
    if (!run.textSeen && response !== undefined) accept({ kind: 'text', text: response })
    const error = textOf(event.error)
    if (error !== undefined) accept({ kind: 'error', message: error })
  }
  return []
}

/** Announce one tool call exactly once, with the input the frame carries. */
function announce(
  accept: (frame: CliFrame) => void,
  run: ZcodeRun,
  payload: Record<string, unknown>,
  knownId?: string,
): void {
  const id = knownId ?? idOf(run, payload)
  if (run.announced.has(id)) return
  run.announced.add(id)
  accept({
    kind: 'tool-call',
    call: {
      id,
      name: textOf(payload.toolName) ?? 'tool',
      arguments: payload.input ?? {},
    },
  })
}

/** The call id of a frame, synthesizing a stable one when the wire omits it. */
function idOf(run: ZcodeRun, payload: Record<string, unknown>): string {
  const id = textOf(payload.toolCallId)
  if (id !== undefined) return id
  run.synthetic += 1
  return `zcode-tool-${run.synthetic}`
}

/** Emit one usage frame when the payload carries counters. */
function emitUsage(usage: unknown, accept: (frame: CliFrame) => void): void {
  const mapped = zcodeUsage(usage)
  if (mapped !== undefined) accept({ kind: 'usage', usage: mapped })
}
