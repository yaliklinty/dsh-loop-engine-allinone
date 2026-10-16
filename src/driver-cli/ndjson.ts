/**
 * The line-delimited-JSON protocol skeleton.
 *
 * Three of the four wire families are "one JSON document per line": the newline
 * framing is identical, and only the FIELD NAMES inside each document differ.
 * So the reader — split a byte stream into lines, parse each, hand it over,
 * and surface a parse failure as a protocol error rather than silently skipping
 * the line — lives here once, and an engine supplies only the mapping from a
 * parsed document to {@link CliFrame}s.
 *
 * The reader also owns the two framing rules that are easy to get wrong and
 * expensive to debug:
 *
 *  - **A trailing partial line is still a line.** A child that exits without a
 *    final newline has still said something, so the last buffer is flushed on
 *    close. Dropping it loses the engine's answer.
 *  - **A blank line is not a document.** Engines interleave progress lines and
 *    keep-alives; an empty line is skipped rather than reported as malformed.
 *
 * @module dsh-loop-engine/driver-cli/ndjson
 */

import type { Readable, Writable } from 'node:stream'
import type { CliFrame } from './frames.ts'
import type { CliTransport } from './transport.ts'

/**
 * Split a byte stream into lines.
 *
 * Yields each complete line WITHOUT its terminator, plus a trailing partial line
 * when the stream ends. A line is decoded as UTF-8: every engine this plugin
 * speaks to emits UTF-8 on its protocol channel (their own locale or OEM
 * encodings, if any, apply to human-facing output rather than the wire).
 * @param stream - the child's stdout.
 * @returns an async iterator of lines.
 */
export async function* readLines(stream: Readable): AsyncIterable<string> {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8')
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      yield buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
  // The child may exit without a trailing newline; the remainder is still a line.
  if (buffer.length > 0) yield buffer.replace(/\r$/, '')
}

/**
 * Parse one NDJSON line.
 * @param line - the raw line.
 * @returns the parsed document, or undefined when the line is blank or not JSON.
 */
export function parseJsonLine(line: string): unknown {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** What one NDJSON run needs. */
export interface NdjsonRunSpec {
  /** The spawned child. */
  readonly transport: CliTransport
  /**
   * A payload to write to the child's stdin before reading, when the prompt
   * travels that way (`agy --input-format stream-json`). Omitted when the
   * prompt is an argv argument.
   */
  readonly stdin?: string
  /**
   * Map one parsed document to frames.
   *
   * Returning an empty array is normal: most protocol lines are progress,
   * session bookkeeping or telemetry that has no durable place. Returning
   * nothing at all is also normal for a document the adapter does not
   * recognize — an unknown frame is DROPPED rather than raised, because a
   * protocol that grows a new notification kind must not break a working
   * engine.
   * @param document - the parsed JSON document.
   * @returns the frames it expresses, in order.
   */
  map(document: unknown): readonly CliFrame[]
  /**
   * Called when a non-blank line could not be parsed as JSON.
   *
   * Counted rather than raised, and only reported at the end: a child that
   * prints a warning on its protocol channel is common, and failing the whole
   * turn over one stray line would be worse than reporting it. If NO line ever
   * parsed, the run fails and this is what says why.
   * @param line - the unparseable line.
   */
  onUnparsed?(line: string): void
}

/** What one NDJSON run produced. */
export interface NdjsonRunResult {
  /** Documents that parsed. */
  readonly parsed: number
  /** Non-blank lines that did not parse. */
  readonly unparsed: number
  /** The last unparseable line, for the diagnostic when nothing parsed. */
  readonly lastUnparsed: string | undefined
}

/**
 * Drive one NDJSON run: write the prompt, decode every line, feed the adapter.
 *
 * Frames are handed to `accept` as they arrive rather than collected, so a
 * long answer streams instead of materializing.
 * @param spec - the run's transport, stdin payload and frame mapper.
 * @param accept - sink for the frames.
 * @returns what the run saw.
 */
export async function runNdjson(
  spec: NdjsonRunSpec,
  accept: (frame: CliFrame) => void,
): Promise<NdjsonRunResult> {
  const { transport } = spec
  const stream = transport.stdout
  if (stream === undefined) throw new Error('loop-engine: the CLI child has no stdout to read')
  if (spec.stdin !== undefined) writeStdin(transport.stdin, spec.stdin)
  let parsed = 0
  let unparsed = 0
  let lastUnparsed: string | undefined
  for await (const line of readLines(stream)) {
    if (line.trim() === '') continue
    const document = parseJsonLine(line)
    if (document === undefined) {
      unparsed += 1
      lastUnparsed = line
      spec.onUnparsed?.(line)
      continue
    }
    parsed += 1
    for (const frame of spec.map(document)) accept(frame)
  }
  // The child's exit is part of the run: a non-zero exit with nothing parsed is
  // a startup failure (a missing binary, a refused login) and must not read as
  // an empty but successful answer.
  await transport.done.catch(() => undefined)
  return { parsed, unparsed, lastUnparsed }
}

/**
 * Write a payload to the child's stdin and close it.
 *
 * Closing matters: an engine reading `stream-json` from stdin runs one turn per
 * line and waits, so a stdin left open hangs the run until the process is
 * killed. A write failure is swallowed — the child may have exited already, and
 * the exit code is the more useful diagnostic.
 * @param stdin - the child's stdin, when the spawn requested a pipe.
 * @param payload - the text to write.
 */
export function writeStdin(stdin: Writable | undefined, payload: string): void {
  if (stdin === undefined) return
  stdin.write(payload)
  stdin.end()
}
