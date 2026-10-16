/**
 * Antigravity (`agy`) CLI process projection.
 *
 * `agy` is the Antigravity CLI. Its non-interactive surface is a `--print` mode
 * with an explicit INPUT format and OUTPUT format; the combination this driver
 * uses is the streaming-NDJSON one, because it is the only shape that carries a
 * machine-readable verdict:
 *
 * ```
 * agy --input-format stream-json --output-format stream-json --print=<prompt-arg>
 * ```
 *
 * with the prompt itself written to stdin as one NDJSON line, and `--print=`
 * given an EMPTY value. That last detail is not cosmetic — it is a real trap
 * recorded in `docs/probes/agy.md`: `--print` takes an OPTIONAL value, so
 * `agy --input-format stream-json --print` makes `--input-format` the prompt and
 * the intended prompt is silently ignored (the CLI says so on stderr). Attaching
 * an empty value (`--print=`) pins the flag's argument and leaves the rest of the
 * command line alone.
 *
 * ## What was verified, and what is still open
 *
 * Verified on this machine against `agy` (help text, flag semantics, the
 * argument-position trap above, and the `result` envelope — captured verbatim in
 * `docs/probes/agy.md`).
 *
 * NOT verified: the per-token streaming frame vocabulary. The host's Google
 * credential had expired, so every probe run ended at
 * `{"event":"result","result":{"status":"ERROR","error":"authentication failed
 * or timed out"}}` before any assistant frame was emitted. Rather than guess,
 * this driver treats the `result` envelope as AUTHORITATIVE for the answer
 * (`result.response`) and accepts `result.usage` for accounting — which is
 * correct whether or not streaming frames exist — and drops frame kinds it does
 * not recognize. The consequence is honest and documented: on a signed-in host
 * the answer is complete, but it is committed as one message rather than
 * streamed token-by-token, which is why {@link ENGINE_CAPABILITIES} declares
 * `streaming: false` for the DRIVER even though the CLI can stream.
 *
 * @module dsh-loop-engine/engine-agy/process
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliSpawnRequest } from '../driver-cli/transport.ts'

/** Grace in milliseconds for Antigravity process-tree termination. */
export const AGY_DISPOSE_GRACE_MS = 3000

/** The `--mode` values the CLI accepts for a session's execution mode. */
export const AGY_MODES = ['accept-edits', 'auto', 'plan'] as const

/** One Antigravity execution mode. */
export type AgyMode = (typeof AGY_MODES)[number]

/** The `--effort` values the CLI accepts. */
export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** One Antigravity reasoning effort. */
export type AgyEffort = (typeof AGY_EFFORTS)[number]

/**
 * Resolve the `agy` executable.
 *
 * Antigravity installs into the user's local application data under `agy/bin`.
 * `LOCALAPPDATA` is consulted rather than a hardcoded home so the same code is
 * right for a profile running under a different user; PATH is the last resort.
 * @param configBin - an operator-pinned path, if any.
 * @returns the executable to spawn as `argv[0]`.
 */
export function agyBinResolver(configBin?: string): string {
  if (configBin !== undefined && configBin !== '') return configBin
  const local = process.env.LOCALAPPDATA
  if (local !== undefined && local !== '') {
    const executable = process.platform === 'win32' ? 'agy.EXE' : 'agy'
    const candidate = join(local, 'agy', 'bin', executable)
    if (existsSync(candidate)) return candidate
  }
  return 'agy'
}

/**
 * Whether the host has an Antigravity credential file on disk.
 *
 * A HINT for the settings page, never a gate: Antigravity owns its credentials,
 * the plugin only reports whether a login has happened at least once. A missing
 * file means "never signed in here"; a PRESENT file can still be expired, which
 * is exactly the state this machine was in when the probe ran, so the file's
 * existence must not be read as "ready".
 * @param home - the user's home directory.
 * @returns whether the credential file exists.
 */
export function agyCredentialPresent(home: string): boolean {
  return existsSync(join(home, '.gemini', 'oauth_creds.json'))
}

/** Everything one step's Antigravity child needs. */
export interface AgySpawnSpec {
  /** The resolved executable (`argv[0]`). */
  readonly bin: string
  /** The prompt text; written to stdin as one NDJSON user message. */
  readonly prompt: string
  /** The session's working directory. */
  readonly cwd: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Pinned model (`--model`). */
  readonly model: string | undefined
  /** Pinned execution mode (`--mode`). */
  readonly mode: AgyMode
  /** Pinned reasoning effort (`--effort`). */
  readonly effort: AgyEffort | undefined
  /** Whether to run the child with terminal restrictions (`--sandbox`). */
  readonly sandbox: boolean
  /** Cancellation. */
  readonly signal: AbortSignal
}

/**
 * Build the argv for one non-interactive Antigravity step.
 *
 * `--print=` carries an EMPTY value on purpose (see the module note): the flag
 * takes an optional argument, so leaving it bare swallows the NEXT flag as the
 * prompt.
 * @param spec - the step's spawn spec.
 * @returns the argv.
 */
export function agyArgv(spec: AgySpawnSpec): string[] {
  return [
    spec.bin,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--mode', spec.mode,
    ...spec.model === undefined ? [] : ['--model', spec.model],
    ...spec.effort === undefined ? [] : ['--effort', spec.effort],
    ...spec.sandbox ? ['--sandbox'] : [],
    // Attached empty value: pins the optional argument so the flags above are
    // not consumed as the prompt.
    '--print=',
  ]
}

/**
 * Project one step's prompt onto the CLI's stdin wire shape.
 *
 * One NDJSON document per line, of which the driver writes exactly one. Written
 * from `progress.md`'s verified example:
 * `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
 * @param prompt - the prompt text.
 * @returns the stdin payload, newline-terminated.
 */
export function agyStdinPrompt(prompt: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  })}\n`
}

/**
 * Project one step's spawn spec onto the transport request.
 * @param spec - the step's spawn spec.
 * @returns the transport's request shape.
 */
export function agySpawnRequest(spec: AgySpawnSpec): CliSpawnRequest {
  return { argv: agyArgv(spec), cwd: spec.cwd, env: spec.env, signal: spec.signal }
}
