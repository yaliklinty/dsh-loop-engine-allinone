/**
 * The plain-text protocol skeleton, and the judgement it exists to make:
 * "did the engine actually answer?".
 *
 * The exit-status rule is the whole value of this module. An engine that dies
 * mid-answer has still printed something, and committing that partial text as
 * the reply would be the silent-success failure the plugin is built to avoid; an
 * engine that exits 0 with nothing on stdout has answered nothing and must not
 * read as an empty-but-fine turn.
 *
 * @module tests/driver-cli/text
 */

import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { runText, textRunOutcome, type TextRunResult } from '../../src/driver-cli/text.ts'
import type { CliTransport } from '../../src/driver-cli/transport.ts'

/** A transport over the given streams and exit outcome. */
function transportOf(
  stdout: string | undefined,
  stderr: string | undefined,
  done: Promise<unknown> = Promise.resolve({ exitCode: 0 }),
  stdin?: { write: (chunk: string) => boolean; end: () => void },
): CliTransport {
  return {
    stdin: stdin as never,
    stdout: stdout === undefined ? undefined : Readable.from([stdout]),
    stderr: stderr === undefined ? undefined : Readable.from([stderr]),
    done,
    terminate: () => {},
  }
}

describe('runText', () => {
  it('collects stdout, stderr and the exit code', async () => {
    const result = await runText({
      transport: transportOf('PONG\n', '', Promise.resolve({ exitCode: 0 })),
    })
    expect(result).toEqual({ stdout: 'PONG\n', stderr: '', exitCode: 0 })
  })

  it('tolerates an absent stream, and reports no exit code when the outcome carries none', async () => {
    const result = await runText({ transport: transportOf(undefined, undefined, Promise.resolve({})) })
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: null })
  })

  it('decodes a Buffer chunk as UTF-8', async () => {
    const result = await runText({
      transport: {
        stdin: undefined,
        stdout: Readable.from([Buffer.from('PONG', 'utf8')]),
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 0 }),
        terminate: () => {},
      },
    })
    expect(result.stdout).toBe('PONG')
  })

  it('writes and closes stdin when a payload is given', async () => {
    let ended = false
    const written: string[] = []
    await runText({
      transport: transportOf('ok', '', Promise.resolve({ exitCode: 0 }), {
        write: (chunk: string) => { written.push(chunk); return true },
        end: () => { ended = true },
      }),
      stdin: 'prompt',
    })
    expect(written).toEqual(['prompt'])
    expect(ended).toBe(true)
  })

  it('reports a null exit code when the wait itself rejected', async () => {
    const result = await runText({ transport: transportOf('partial', '', Promise.reject(new Error('killed'))) })
    expect(result.exitCode).toBeNull()
  })

  it('truncates a chatty child’s stderr to the tail', async () => {
    // Bounded so a child stuck in a warning loop cannot exhaust memory; the tail
    // rather than the head because the final lines are the ones that say why.
    const result = await runText({ transport: transportOf('x', 'a'.repeat(9000) + 'CAUSE') })
    expect(result.stderr.length).toBe(8192)
    expect(result.stderr.endsWith('CAUSE')).toBe(true)
  })
})

describe('textRunOutcome', () => {
  const run = (partial: Partial<TextRunResult>): TextRunResult =>
    ({ stdout: '', stderr: '', exitCode: 0, ...partial })

  it('accepts an answer from a clean exit', () => {
    expect(textRunOutcome(run({ stdout: 'PONG\n' }))).toEqual({ kind: 'answered', text: 'PONG\n' })
  })

  it('refuses a non-zero exit even when text was printed', () => {
    // The engine died mid-answer: reporting the partial text would claim it
    // finished.
    const outcome = textRunOutcome(run({ stdout: 'PON', stderr: 'connection reset', exitCode: 1 }))
    expect(outcome).toEqual({ kind: 'failed', message: 'connection reset' })
  })

  it('names the exit code when the child said nothing on stderr', () => {
    expect(textRunOutcome(run({ exitCode: 3 }))).toEqual({ kind: 'failed', message: 'the engine exited with code 3' })
  })

  it('refuses an empty answer from a clean exit', () => {
    expect(textRunOutcome(run({ stdout: '   \n' }))).toEqual({ kind: 'failed', message: 'the engine produced no output' })
  })

  it('prefers stderr as the reason for an empty clean-exit answer', () => {
    // A CLI that exits 0 while explaining itself on stderr is common; its own
    // words are more useful than "no output".
    expect(textRunOutcome(run({ stderr: 'not signed in' }))).toEqual({ kind: 'failed', message: 'not signed in' })
  })

  it('treats a signal death (null exit) with text as an answer', () => {
    // A null exit code means "no code observed", not "failed": the seamed
    // provider reports a signal death that way, and an engine killed after
    // printing its answer did answer.
    expect(textRunOutcome(run({ stdout: 'PONG', exitCode: null })).kind).toBe('answered')
  })
})

describe('an exit outcome that is not an object', () => {
  it('reports a null exit code when the seam resolved with a bare value', async () => {
    // The seam's `done` resolves with an outcome object, but a mock or a future
    // seam may resolve with nothing at all. `exitCodeOf` must answer "unknown"
    // rather than reading `.exitCode` off null and throwing inside the adapter.
    for (const outcome of [null, undefined, 'exited', 7]) {
      const result = await runText({ transport: transportOf('PONG', '', Promise.resolve(outcome)) })
      expect(result.exitCode, String(outcome)).toBeNull()
    }
  })

  it('still reads stdout and the answer with an unknown exit code', async () => {
    const result = await runText({ transport: transportOf('PONG', '', Promise.resolve(null)) })
    expect(textRunOutcome(result)).toEqual({ kind: 'answered', text: 'PONG' })
  })
})
