/**
 * The plain-text protocol skeleton.
 *
 * The simplest family, and a real one rather than a fallback: an engine invoked
 * as `engine -p "prompt"` prints its finished answer on stdout and exits. There
 * are no frames, no tool events and no usage — just text.
 *
 * Two consequences the driver has to state rather than hide:
 *
 *  - **No streaming.** The answer exists only once the child is done (or once
 *    stdout stops growing), so `capabilities.streaming` is `false` for such an
 *    engine and the settings page/UI must not promise token-by-token output.
 *  - **No tool events.** A text engine may run tools internally, but it reports
 *    none of them, so nothing lands in the tool rows. That is a faithful
 *    transcript, not a gap: the plugin reports what the engine said.
 *
 * Exit status is part of the answer. A non-zero exit with empty stdout is a
 * failed run with the child's own stderr as the message; a non-zero exit WITH
 * output is still reported as a failure, because an engine that dies mid-answer
 * has not answered.
 *
 * @module dsh-loop-engine/driver-cli/text
 */

import type { CliTransport } from './transport.ts'

/** Bounded stderr capture, so a chatty child cannot exhaust memory. */
const STDERR_LIMIT = 8192

/** What one text run produced. */
export interface TextRunResult {
  /** The child's stdout, verbatim. */
  readonly stdout: string
  /** The child's stderr, truncated to the last {@link STDERR_LIMIT} characters. */
  readonly stderr: string
  /** Exit code, or null when the child died from a signal. */
  readonly exitCode: number | null
}

/** What one text run needs. */
export interface TextRunSpec {
  /** The spawned child. */
  readonly transport: CliTransport
  /**
   * A payload to write to the child's stdin, when the prompt travels that way.
   * Closing stdin is what lets an engine that reads to EOF start working.
   */
  readonly stdin?: string
}

/**
 * Read a whole stream as UTF-8.
 * @param stream - the stream, or undefined when the spawn did not request it.
 * @returns everything it produced.
 */
async function drain(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (stream === undefined) return ''
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'))
  }
  return chunks.join('')
}

/**
 * Run one plain-text query to completion.
 * @param spec - the run's transport and optional stdin payload.
 * @returns the child's output and exit facts.
 */
export async function runText(spec: TextRunSpec): Promise<TextRunResult> {
  const { transport } = spec
  if (spec.stdin !== undefined && transport.stdin !== undefined) {
    transport.stdin.write(spec.stdin)
    transport.stdin.end()
  }
  const [stdout, stderr, outcome] = await Promise.all([
    drain(transport.stdout),
    drain(transport.stderr),
    transport.done.catch((error: unknown) => ({ exitCode: null, error })),
  ])
  const exitCode = exitCodeOf(outcome)
  return {
    stdout,
    stderr: stderr.length > STDERR_LIMIT ? stderr.slice(-STDERR_LIMIT) : stderr,
    exitCode,
  }
}

/** Read an exit code out of a seam outcome, or null when there is none. */
function exitCodeOf(outcome: unknown): number | null {
  if (outcome === null || typeof outcome !== 'object') return null
  const code = (outcome as { exitCode?: unknown }).exitCode
  return typeof code === 'number' ? code : null
}

/**
 * Turn a finished text run into the answer, or the reason there is none.
 *
 * Kept separate from {@link runText} so the decision is testable without
 * spawning anything: it is where the "did the engine actually answer?"
 * judgement lives.
 * @param result - the finished run.
 * @returns the answer text, or the failure message to report.
 */
export function textRunOutcome(result: TextRunResult):
  | { readonly kind: 'answered'; readonly text: string }
  | { readonly kind: 'failed'; readonly message: string } {
  const text = result.stdout.trim()
  if (result.exitCode !== 0 && result.exitCode !== null) {
    const detail = result.stderr.trim() !== '' ? result.stderr.trim() : `the engine exited with code ${result.exitCode}`
    return { kind: 'failed', message: detail }
  }
  if (text === '') {
    const detail = result.stderr.trim() !== '' ? result.stderr.trim() : 'the engine produced no output'
    return { kind: 'failed', message: detail }
  }
  return { kind: 'answered', text: result.stdout }
}
