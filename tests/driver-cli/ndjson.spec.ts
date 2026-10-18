/**
 * The NDJSON protocol skeleton: line framing, JSON parsing, and the run driver.
 *
 * The framing rules are the point. A child that exits without a final newline
 * has still said something (an engine's whole answer can be that line), and a
 * blank line is progress chatter rather than a malformed document. Both are
 * asserted here because both are silent when wrong: a dropped trailing line
 * looks like "the engine answered nothing", and a reported blank line looks
 * like a protocol error.
 *
 * @module tests/driver-cli/ndjson
 */

import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { parseJsonLine, readLines, runNdjson, writeStdin } from '../../src/driver-cli/ndjson.ts'
import type { CliFrame } from '../../src/driver-cli/frames.ts'
import type { CliTransport } from '../../src/driver-cli/transport.ts'

/** A readable that yields the given chunks in order. */
function stream(...chunks: string[]): Readable {
  return Readable.from(chunks)
}

/** A transport whose stdout is the given stream, with no stdin. */
function transportOf(stdout: Readable, done: Promise<unknown> = Promise.resolve({ exitCode: 0 })): CliTransport {
  return { stdin: undefined, stdout, stderr: undefined, done, terminate: () => {} }
}

/** Collect every line a stream produces. */
async function lines(...chunks: string[]): Promise<string[]> {
  const out: string[] = []
  for await (const line of readLines(stream(...chunks))) out.push(line)
  return out
}

describe('readLines', () => {
  it('splits on newlines and drops the terminator', async () => {
    expect(await lines('a\nb\nc\n')).toEqual(['a', 'b', 'c'])
  })

  it('keeps a trailing partial line, because the child may not write a final newline', async () => {
    // The failure this prevents: an engine whose entire answer is the last line
    // looks like it answered nothing.
    expect(await lines('{"a":1}\n{"answer":"PONG"}')).toEqual(['{"a":1}', '{"answer":"PONG"}'])
  })

  it('reassembles a document split across chunk boundaries', async () => {
    // A pipe hands over whatever bytes arrived, so a line routinely straddles
    // two chunks. Splitting per chunk would parse each half as malformed.
    expect(await lines('{"hel', 'lo":', '"world"}\n')).toEqual(['{"hello":"world"}'])
  })

  it('strips a trailing carriage return, so CRLF output parses', async () => {
    expect(await lines('{"a":1}\r\n')).toEqual(['{"a":1}'])
  })

  it('yields nothing for an empty stream', async () => {
    expect(await lines()).toEqual([])
  })
})

describe('parseJsonLine', () => {
  it('parses a document', () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 })
  })

  it('treats a blank line as absent rather than malformed', () => {
    expect(parseJsonLine('')).toBeUndefined()
    expect(parseJsonLine('   \t ')).toBeUndefined()
  })

  it('answers undefined for a line that is not JSON', () => {
    expect(parseJsonLine('Warning: something happened')).toBeUndefined()
  })
})

describe('writeStdin', () => {
  it('writes the payload and closes the pipe', () => {
    // Closing is the load-bearing half: an engine reading stream-json from stdin
    // runs a turn per line and waits, so an open stdin hangs the step.
    const written: string[] = []
    let ended = false
    writeStdin({
      write: (chunk: string) => { written.push(chunk); return true },
      end: () => { ended = true },
    } as never, 'payload\n')
    expect(written).toEqual(['payload\n'])
    expect(ended).toBe(true)
  })

  it('is a no-op without a stdin pipe', () => {
    expect(() => { writeStdin(undefined, 'payload') }).not.toThrow()
  })
})

describe('runNdjson', () => {
  it('feeds every parsed document to the mapper, in order', async () => {
    const seen: unknown[] = []
    const result = await runNdjson(
      {
        transport: transportOf(stream('{"n":1}\n', '{"n":2}\n')),
        map: (document) => {
          seen.push(document)
          return []
        },
      },
      () => {},
    )
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
    expect(result).toEqual({ parsed: 2, unparsed: 0, lastUnparsed: undefined })
  })

  it('counts an unparseable line without failing the run', async () => {
    // A CLI that prints a warning on its protocol channel is common; failing the
    // turn over one stray line would be worse than reporting it.
    const reported: string[] = []
    const result = await runNdjson(
      {
        transport: transportOf(stream('not json\n{"n":1}\n')),
        map: () => [],
        onUnparsed: (line) => { reported.push(line) },
      },
      () => {},
    )
    expect(result.parsed).toBe(1)
    expect(result.unparsed).toBe(1)
    expect(result.lastUnparsed).toBe('not json')
    expect(reported).toEqual(['not json'])
  })

  it('writes the stdin payload before reading', async () => {
    const written: string[] = []
    let ended = false
    const transport: CliTransport = {
      stdin: { write: (chunk: string) => { written.push(chunk); return true }, end: () => { ended = true } } as never,
      stdout: stream('{"n":1}\n'),
      stderr: undefined,
      done: Promise.resolve({ exitCode: 0 }),
      terminate: () => {},
    }
    await runNdjson({ transport, stdin: 'prompt\n', map: () => [] }, () => {})
    expect(written).toEqual(['prompt\n'])
    expect(ended).toBe(true)
  })

  it('accepts the frames a mapper returns', async () => {
    const frames: CliFrame[] = []
    await runNdjson(
      { transport: transportOf(stream('{"text":"hi"}\n')), map: () => [{ kind: 'text', text: 'hi' }] },
      frame => frames.push(frame),
    )
    expect(frames).toEqual([{ kind: 'text', text: 'hi' }])
  })

  it('refuses a transport with no stdout to read', async () => {
    const frames: CliFrame[] = []
    await expect(runNdjson(
      { transport: { ...transportOf(stream()), stdout: undefined }, map: () => [] },
      frame => frames.push(frame),
    )).rejects.toThrow(/no stdout/)
  })

  it('waits for the child to exit, swallowing an exit-time rejection', async () => {
    // The exit outcome is awaited so a caller sees a run that ended; a failed
    // wait must not turn a decoded answer into a thrown error, because the exit
    // code is reported by the driver's own failure path.
    let settled = false
    await runNdjson(
      {
        transport: transportOf(stream('{"n":1}\n'), Promise.reject(new Error('killed')).finally(() => { settled = true })),
        map: () => [],
      },
      () => {},
    )
    expect(settled).toBe(true)
  })
})

describe('blank lines inside a run', () => {
  it('skips a blank line between documents instead of counting it as unparsed', async () => {
    // Engines interleave progress lines and keep-alives. Counting a blank line
    // as malformed would make `lastUnparsed` name an empty string and turn a
    // healthy run into a reported protocol error.
    const reported: string[] = []
    const seen: unknown[] = []
    const result = await runNdjson(
      {
        transport: transportOf(stream('{"n":1}\n\n   \n{"n":2}\n')),
        map: (document) => { seen.push(document); return [] },
        onUnparsed: (line) => { reported.push(line) },
      },
      () => {},
    )
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
    expect(result).toMatchObject({ parsed: 2, unparsed: 0, lastUnparsed: undefined })
    expect(reported).toEqual([])
  })
})
