/**
 * End-to-end smoke test for one CLI engine's PROTOCOL path.
 *
 * The probe script records what a CLI emits; this records what the DRIVER does
 * with it. It runs the driver's own argv builder and frame mapper against the
 * real executable and prints the normalized frames — so "the driver speaks this
 * engine's protocol" is demonstrated rather than asserted.
 *
 * It deliberately does NOT go through the dsh subprocess seam or a Cordis
 * context: it is a protocol check, not a lifecycle check. The lifecycle is
 * covered by the unit specs and by a real profile mount.
 *
 * ```sh
 * node --experimental-strip-types scripts/probe/smoke-driver.ts qoderclicn
 * ```
 * (or `npx tsx scripts/probe/smoke-driver.ts qoderclicn`)
 *
 * @module scripts/probe/smoke-driver
 */

import { spawn } from 'node:child_process'
import type { CliFrame } from '../../src/driver-cli/frames.ts'
import { readLines } from '../../src/driver-cli/ndjson.ts'
import { mapStreamJsonDocument } from '../../src/driver-cli/stream-json.ts'
import { mapAgyDocument, newAgyRun } from '../../src/engine-agy/frames.ts'
import { agyArgv, agyStdinPrompt } from '../../src/engine-agy/process.ts'
import { hermesArgv } from '../../src/engine-hermes/process.ts'
import { qoderclicnArgv } from '../../src/engine-qoderclicn/process.ts'

const PROMPT = 'Reply with exactly: PONG'

/** Run one child, feeding every stdout line to the mapper. */
async function drive(
  id: string,
  argv: readonly string[],
  map: (document: unknown) => readonly CliFrame[],
  stdin: string | undefined,
  env: Record<string, string> = {},
): Promise<CliFrame[]> {
  const [command, ...rest] = argv
  if (command === undefined) throw new Error('no command')
  const child = spawn(command, rest, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  child.stdin.end(stdin ?? '')
  const frames: CliFrame[] = []
  let parsed = 0
  let unparsed = 0
  for await (const line of readLines(child.stdout)) {
    if (line.trim() === '') continue
    let document: unknown
    try {
      document = JSON.parse(line)
    } catch {
      unparsed += 1
      continue
    }
    parsed += 1
    for (const frame of map(document)) frames.push(frame)
  }
  await new Promise<void>((settle) => { child.on('close', () => { settle() }) })
  console.log(`[${id}] parsed ${parsed} document(s), ${unparsed} unparsed`)
  if (stderr.trim() !== '') console.log(`[${id}] stderr: ${stderr.trim().split('\n').slice(0, 3).join(' | ')}`)
  return frames
}

const target = process.argv[2] ?? 'qoderclicn'
const frames: CliFrame[] = []

if (target === 'qoderclicn') {
  frames.push(...await drive(
    target,
    qoderclicnArgv({
      bin: 'qoderclicn',
      prompt: PROMPT,
      cwd: process.cwd(),
      env: {},
      model: undefined,
      permissionMode: 'default',
      signal: new AbortController().signal,
    }),
    (document) => {
      const collected: CliFrame[] = []
      const run = { sessionId: undefined as string | undefined, reportedError: undefined as string | undefined }
      mapStreamJsonDocument(document, frame => collected.push(frame), run)
      return collected
    },
    undefined,
  ))
} else if (target === 'agy') {
  frames.push(...await drive(
    target,
    agyArgv({
      bin: 'agy',
      prompt: PROMPT,
      cwd: process.cwd(),
      env: {},
      model: undefined,
      mode: undefined,
      effort: undefined,
      sandbox: true,
      signal: new AbortController().signal,
    }),
    // ONE accumulator for the whole run, exactly as the driver builds it: the
    // `answered` flag is what stops the `result` envelope from committing the
    // answer a second time after the deltas already delivered it.
    (() => {
      const run = newAgyRun()
      return (document: unknown) => {
        const collected: CliFrame[] = []
        mapAgyDocument(document, frame => collected.push(frame), run)
        return collected
      }
    })(),
    agyStdinPrompt(PROMPT),
  ))
} else if (target === 'hermes') {
  // The text protocol has no frames to map: the whole of stdout is the answer.
  // Reported here anyway, so the smoke script covers every verified engine.
  const [command, ...rest] = hermesArgv({
    bin: 'hermes',
    prompt: PROMPT,
    cwd: process.cwd(),
    env: {},
    model: undefined,
    reasoning: undefined,
    signal: new AbortController().signal,
  })
  if (command === undefined) throw new Error('no command')
  const child = spawn(command, rest, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stdin.end()
  await new Promise<void>((settle) => { child.on('close', () => { settle() }) })
  frames.push({ kind: 'text', text: stdout.trim() })
} else {
  console.error(`unknown engine: ${target}`)
  process.exit(2)
}

console.log('\nnormalized frames:')
for (const frame of frames) console.log(' ', JSON.stringify(frame))
const answer = frames.filter(frame => frame.kind === 'text').map(frame => (frame as { text: string }).text).join('')
console.log(`\nanswer: ${JSON.stringify(answer.trim())}`)
console.log(answer.includes('PONG') ? 'SMOKE OK' : 'SMOKE: the engine did not answer PONG (see frames above)')
