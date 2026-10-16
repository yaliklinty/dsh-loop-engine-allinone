/**
 * The Claude-Code-compatible `stream-json` adapter.
 *
 * A whole family of CLIs speak one shared `--output-format stream-json`
 * dialect: Claude Code itself, and the forks built on it (Qoder's CLI among
 * them — verified by probing `qoderclicn -p --output-format stream-json`, whose
 * frames carry the same `type`/`subtype`/`session_id` vocabulary). The dialect
 * is NDJSON, one document per line, with four document kinds that matter:
 *
 *   - `system` / `init` — the session opened; carries `session_id`, the model
 *     and the tool list. Useful for resume and diagnostics, no durable content.
 *   - `assistant` — one assistant message, whose `message.content` is a list of
 *     Anthropic-shaped blocks (`text`, `thinking`, `tool_use`). This is where
 *     the answer and the tool calls come from.
 *   - `user` — a tool RESULT being fed back (`tool_result` blocks). A CLI that
 *     runs its own tools reports the outcome here.
 *   - `result` — the run ended; carries `result` (the final text), `is_error`,
 *     `usage` and the session id.
 *
 * Because the dialect is shared, the mapping lives here once and each engine
 * supplies only its transport. That is also why tool names are NOT projected
 * here: projection is per-engine (`normalizeHostedToolCall`), so this module
 * reports the engine's own spelling and the sink projects it.
 *
 * Everything the dialect can carry that has no durable place — `hook_started`,
 * `hook_progress`, `hook_response`, `artifacts_update`, `stream_event` and any
 * future notification — is DROPPED rather than raised. A CLI that grows a new
 * notification must not break a working driver.
 *
 * @module dsh-loop-engine/driver-cli/stream-json
 */

import type { CliFrame, CliUsage } from './frames.ts'
import { flattenToolResult } from './flatten.ts'

/** What one stream-json run's frames were accepted by. */
export type FrameSink = (frame: CliFrame) => void

/** One decoded stream-json document, as this adapter reads it. */
interface StreamJsonDocument {
  readonly type?: unknown
  readonly subtype?: unknown
  readonly session_id?: unknown
  readonly message?: unknown
  readonly result?: unknown
  readonly is_error?: unknown
  readonly usage?: unknown
  readonly error?: unknown
}

/** What the adapter learned about the run beyond its frames. */
export interface StreamJsonRun {
  /** The session id the CLI reported, when it reported one. */
  readonly sessionId: string | undefined
  /** Whether the CLI's own `result` document said the run failed. */
  readonly reportedError: string | undefined
}

/**
 * Read a numeric usage field, tolerating the dialect's two spellings.
 *
 * Engines report usage under Anthropic's names (`input_tokens`) or in a
 * camelCase variant; both are seen in the wild, so both are read. An absent
 * field stays absent — dsh distinguishes "reported zero" from "not reported".
 * @param record - the usage record.
 * @param snake - the snake_case key.
 * @param camel - the camelCase key.
 * @returns the value, or undefined.
 */
function numberOf(record: Record<string, unknown>, snake: string, camel: string): number | undefined {
  const value = record[snake] ?? record[camel]
  return typeof value === 'number' ? value : undefined
}

/**
 * Project one stream-json usage record onto {@link CliUsage}.
 * @param usage - the engine's usage record.
 * @returns the usage, omitting everything not reported.
 */
export function streamJsonUsage(usage: unknown): CliUsage | undefined {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined
  const record = usage as Record<string, unknown>
  const input = numberOf(record, 'input_tokens', 'inputTokens')
  const output = numberOf(record, 'output_tokens', 'outputTokens')
  // A usage record with neither counter says nothing usable: reporting zeros
  // would be a fabricated measurement.
  if (input === undefined && output === undefined) return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...numberOf(record, 'cache_read_input_tokens', 'cacheReadInputTokens') === undefined
      ? {}
      : { cacheRead: numberOf(record, 'cache_read_input_tokens', 'cacheReadInputTokens')! },
    ...numberOf(record, 'cache_creation_input_tokens', 'cacheCreationInputTokens') === undefined
      ? {}
      : { cacheWrite: numberOf(record, 'cache_creation_input_tokens', 'cacheCreationInputTokens')! },
  }
}

/**
 * Map one assistant message's content blocks to frames.
 *
 * Text becomes a `text` frame, `thinking` a `reasoning` frame, and `tool_use` a
 * `tool-call`. A block kind this build does not know is dropped: reporting an
 * unknown block as text would put JSON in the transcript.
 * @param content - the Anthropic-shaped block list.
 * @param accept - frame sink.
 */
function mapAssistantContent(content: unknown, accept: FrameSink): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    switch (record.type) {
      case 'text':
        if (typeof record.text === 'string' && record.text !== '') accept({ kind: 'text', text: record.text })
        break
      case 'thinking':
        if (typeof record.thinking === 'string' && record.thinking !== '') {
          accept({ kind: 'reasoning', text: record.thinking })
        }
        break
      case 'tool_use':
        if (typeof record.id === 'string' && typeof record.name === 'string') {
          accept({ kind: 'tool-call', call: { id: record.id, name: record.name, arguments: record.input } })
        }
        break
      default:
        break
    }
  }
}

/**
 * Map one user message's content blocks to frames.
 *
 * Only `tool_result` blocks are meaningful here: they are the engine reporting
 * the outcome of a tool it ran itself. User text does not belong in this
 * direction — the driver already knows what it sent.
 * @param content - the Anthropic-shaped block list.
 * @param accept - frame sink.
 */
function mapUserContent(content: unknown, accept: FrameSink): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'tool_result') continue
    if (typeof record.tool_use_id !== 'string') continue
    accept({
      kind: 'tool-result',
      result: {
        id: record.tool_use_id,
        text: flattenToolResult(record.content),
        isError: record.is_error === true,
      },
    })
  }
}

/**
 * Map one parsed stream-json document to frames.
 *
 * The returned `run` is the adapter's accumulated knowledge (the session id and
 * the CLI's own verdict), which the caller needs on top of the frames.
 * @param document - the parsed document.
 * @param accept - frame sink.
 * @param run - the accumulator, updated in place.
 */
export function mapStreamJsonDocument(
  document: unknown,
  accept: FrameSink,
  run: { sessionId: string | undefined; reportedError: string | undefined },
): void {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return
  const frame = document as StreamJsonDocument
  const type = typeof frame.type === 'string' ? frame.type : undefined
  if (typeof frame.session_id === 'string' && frame.session_id !== '') run.sessionId = frame.session_id
  switch (type) {
    case 'assistant': {
      const message = frame.message
      if (message === null || typeof message !== 'object') return
      const usage = streamJsonUsage((message as Record<string, unknown>).usage)
      if (usage !== undefined) accept({ kind: 'usage', usage })
      mapAssistantContent((message as Record<string, unknown>).content, accept)
      return
    }
    case 'user': {
      const message = frame.message
      if (message === null || typeof message !== 'object') return
      mapUserContent((message as Record<string, unknown>).content, accept)
      return
    }
    case 'result': {
      // The CLI's own verdict on the run. `is_error` is authoritative; a
      // `subtype` other than `success` counts as a failure even when the flag is
      // absent, because a fork was observed to set only one of the two.
      const subtype = typeof frame.subtype === 'string' ? frame.subtype : undefined
      const isError = frame.is_error === true || (subtype !== undefined && subtype !== 'success')
      if (isError) {
        const message = typeof frame.result === 'string' && frame.result !== ''
          ? frame.result
          : typeof frame.error === 'string' && frame.error !== ''
            ? frame.error
            : `the engine ended the run with "${subtype ?? 'an error'}"`
        run.reportedError = message
        accept({ kind: 'error', message })
      }
      const usage = streamJsonUsage(frame.usage)
      if (usage !== undefined) accept({ kind: 'usage', usage })
      accept({ kind: 'settle' })
      return
    }
    default:
      // `system` (init/progress/hooks), `stream_event`, `artifacts_update` and
      // anything a future release adds: no durable place, dropped on purpose.
      return
  }
}
