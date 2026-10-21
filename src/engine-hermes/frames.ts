/**
 * Hermes Agent's `--format stream-json` event mapper.
 *
 * The `-z` one-shot prints only the final answer, but Hermes' own single-query
 * chat mode has a machine protocol:
 *
 * ```
 * hermes chat -q "<prompt>" --oneshot --format stream-json
 * ```
 *
 * whose JSONL schema is defined in Hermes 0.21.4's
 * `hermes_cli/stream_json.py`: `system/init`, `text`, `tool_use`,
 * `tool_result`, and one terminal `result`. This module maps that stream to the
 * plugin's frames, which is what makes Hermes' tool calls visible in the durable
 * log — the same information the desktop app renders.
 *
 * Measured against 0.21.4: `system` and `result` were captured on this host; the
 * `text` / `tool_use` / `tool_result` payload shapes are read from the emitter's
 * own source (`on_text_delta`, `on_tool_progress`) and the CLI's help output
 * documents the format as stable for programmatic use.
 *
 * A tool result may omit `tool_call_id`; when it does, the oldest pending call
 * with the same name is settled, which is Hermes' execution order (its tools run
 * sequentially unless the model explicitly batches them).
 *
 * @module dsh-loop-engine-allinone/engine-hermes/frames
 */

import type { CliFrame, CliUsage } from '../driver-cli/frames.ts'

/** What the mapper learned about the run beyond its frames. */
export interface HermesRun {
  /** Session id Hermes reported. */
  sessionId: string | undefined
  /** Whether any `text` event was emitted (the terminal `result.text` repeats it). */
  textSeen: boolean
  /** Calls announced but not yet settled, in announcement order. */
  readonly pending: Array<{ readonly id: string; readonly name: string }>
  /** Counter for a tool event that omits its call id. */
  synthetic: number
}

/** Create a fresh run accumulator. */
export function newHermesRun(): HermesRun {
  return { sessionId: undefined, textSeen: false, pending: [], synthetic: 0 }
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

/** Map Hermes' `tokens` block to the shared usage shape. */
export function hermesUsage(tokens: unknown): CliUsage | undefined {
  const record = recordOf(tokens)
  if (record === undefined) return undefined
  const count = (key: string): number | undefined => typeof record[key] === 'number' ? record[key] as number : undefined
  const input = count('input')
  const output = count('output')
  if (input === undefined && output === undefined) return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...count('cache_read') === undefined ? {} : { cacheRead: count('cache_read')! },
    ...count('cache_write') === undefined ? {} : { cacheWrite: count('cache_write')! },
  }
}

/**
 * Map one parsed Hermes stream-json document to frames.
 * @param document - the parsed JSON line.
 * @param accept - frame sink.
 * @param run - the run accumulator, updated in place.
 * @returns always empty; frames are pushed directly.
 */
export function mapHermesDocument(
  document: unknown,
  accept: (frame: CliFrame) => void,
  run: HermesRun,
): readonly CliFrame[] {
  const event = recordOf(document)
  if (event === undefined) return []
  const sessionId = textOf(event.session_id)
  if (sessionId !== undefined) run.sessionId = sessionId
  const type = textOf(event.type)
  if (type === 'system') return []

  if (type === 'text') {
    const text = typeof event.text === 'string' ? event.text : undefined
    if (text !== undefined && text !== '') {
      run.textSeen = true
      accept({ kind: 'text', text })
    }
    return []
  }

  if (type === 'tool_use') {
    const name = textOf(event.name) ?? 'tool'
    const id = textOf(event.tool_call_id) ?? nextId(run)
    run.pending.push({ id, name })
    accept({ kind: 'tool-call', call: { id, name, arguments: event.input ?? {} } })
    return []
  }

  if (type === 'tool_result') {
    const name = textOf(event.name) ?? 'tool'
    const id = textOf(event.tool_call_id) ?? takePending(run, name)
    if (id === undefined) return []
    const output = typeof event.output === 'string' ? event.output : String(event.output ?? '')
    accept({
      kind: 'tool-result',
      result: { id, text: output === '' ? '(no content)' : output, isError: event.is_error === true },
    })
    return []
  }

  if (type === 'result') {
    const usage = hermesUsage(event.tokens)
    if (usage !== undefined) accept({ kind: 'usage', usage })
    const error = textOf(event.error)
    const text = typeof event.text === 'string' ? event.text : undefined
    if (error !== undefined) {
      accept({ kind: 'error', message: error })
    } else if (!run.textSeen && text !== undefined && text !== '') {
      accept({ kind: 'text', text })
    }
    const exitCode = typeof event.exit_code === 'number' ? event.exit_code : 0
    if (exitCode !== 0 && error === undefined) {
      accept({ kind: 'error', message: text !== undefined && text !== '' ? text : `hermes exited with code ${exitCode}` })
    }
  }
  return []
}

/** A stable synthetic id for a tool frame that omits one. */
function nextId(run: HermesRun): string {
  run.synthetic += 1
  return `hermes-tool-${run.synthetic}`
}

/** Settle the oldest pending call with this name, removing it from the queue. */
function takePending(run: HermesRun, name: string): string | undefined {
  const index = run.pending.findIndex(call => call.name === name)
  const at = index === -1 ? 0 : index
  const [call] = run.pending.splice(at, 1)
  return call?.id
}
