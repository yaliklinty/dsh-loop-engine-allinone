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
 * ## Verified against a signed-in host
 *
 * The first probe run could not get past
 * `{"event":"result","result":{"status":"ERROR","error":"authentication failed or
 * timed out"}}` — the host's Google credential had expired — so the streaming
 * vocabulary was recorded as UNKNOWN rather than guessed. Re-probing after the
 * host signed in produced the whole protocol (`docs/probes/agy.md`, raw captures
 * with `scripts/probe/probe.mjs agy`), and this module and `./frames.ts` are written
 * against it. The three findings that shape the code:
 *
 * 1. **`--print` takes an OPTIONAL value**, so a bare `--print` makes the NEXT
 *    flag the prompt and silently ignores the real one (the CLI says so on
 *    stderr after the fact). Attaching an empty value (`--print=`) pins it.
 * 2. **The stdin message needs an `event` field**: one NDJSON line of
 *    `{"event":"user","message":{"role":"user","content":[…blocks…]}}`. Without
 *    it the CLI answers
 *    `error: stream input message is missing the "event" field`; an event it does
 *    not know is only a warning and is ignored.
 * 3. **Headless mode cannot prompt, so a tool that needs permission is
 *    AUTO-DENIED** (`permission_mode: "request-review"` at `init`), and the turn
 *    ends with the CLI's own explanation. `--dangerously-skip-permissions` is
 *    what switches it to `permission_mode: "always-proceed"`. `--mode` does NOT
 *    affect this — `accept-edits` and `plan` both leave `request-review` — so the
 *    dsh sandbox knob is mapped to exactly that one flag (see
 *    {@link agyDangerouslySkipPermissions}).
 *
 * @module dsh-loop-engine/engine-agy/process
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DshSandboxMode } from '../driver-core/permission-knobs.ts'
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
  /**
   * Pinned execution mode (`--mode`), when the deployment named one.
   *
   * Optional with no default ON PURPOSE, and that is a finding rather than a
   * shrug: `--mode auto` was observed to be refused for the probe host's account
   * ("not available for this account; continuing in the default mode"), so the
   * set of modes a given account accepts is not knowable ahead of time. Omitting
   * the flag lets the CLI use its own default instead of warning on every step.
   */
  readonly mode: AgyMode | undefined
  /** Pinned reasoning effort (`--effort`). */
  readonly effort: AgyEffort | undefined
  /** Whether to run the child with terminal restrictions (`--sandbox`). */
  readonly sandbox: boolean
  /**
   * Whether to auto-approve every tool (`--dangerously-skip-permissions`).
   *
   * The ONLY switch that makes tools run headless: without it the CLI reports
   * `permission_mode: "request-review"` and denies anything that would have
   * prompted. Mapped from the dsh sandbox knob by
   * {@link agyDangerouslySkipPermissions}.
   */
  readonly dangerouslySkipPermissions: boolean
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
    ...spec.mode === undefined ? [] : ['--mode', spec.mode],
    ...spec.model === undefined ? [] : ['--model', spec.model],
    ...spec.effort === undefined ? [] : ['--effort', spec.effort],
    ...spec.sandbox ? ['--sandbox'] : [],
    ...spec.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : [],
    // Attached empty value: pins the optional argument so the flags above are
    // not consumed as the prompt.
    '--print=',
  ]
}

/**
 * Project one step's prompt onto the CLI's stdin wire shape.
 *
 * One NDJSON document per line, of which the driver writes exactly one. The
 * `event` member is REQUIRED — it is the discriminator the CLI reads, and its
 * absence is answered with
 * `error: stream input message is missing the "event" field`. An event the CLI
 * does not know is only a warning (`warning: ignoring unsupported stream input
 * message event "message"`) and is ignored, so a future input kind cannot break
 * a working driver. Verified shape:
 * `{"event":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
 * @param prompt - the prompt text.
 * @returns the stdin payload, newline-terminated.
 */
export function agyStdinPrompt(prompt: string): string {
  return `${JSON.stringify({
    event: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  })}\n`
}

/**
 * Map the session's dsh sandbox knob onto Antigravity's permission switch.
 *
 * There is exactly one switch, and it is all-or-nothing. Headless Antigravity
 * runs at `permission_mode: "request-review"` and AUTO-DENIES any tool that would
 * have prompted — the CLI's own words being `a tool required the "command"
 * permission that headless mode cannot prompt for, so it was auto-denied` —
 * while `--dangerously-skip-permissions` moves it to `always-proceed`.
 *
 * So full access is the only knob that earns the flag. Everything else, including
 * "no knobs at all", fails closed and leaves the subprocess sandbox as the
 * boundary.
 *
 * `--mode` is deliberately NOT consulted here: it was verified to leave
 * `permission_mode` at `request-review` for BOTH `accept-edits` and `plan`, so it
 * is an execution mode rather than a permission switch, and using it as one would
 * be a guess dressed up as a mapping.
 * @param sandbox - the session's durable sandbox mode, if any.
 * @returns whether to pass `--dangerously-skip-permissions`.
 */
export function agyDangerouslySkipPermissions(sandbox: DshSandboxMode | undefined): boolean {
  return sandbox === 'danger-full-access'
}

/**
 * Project one step's spawn spec onto the transport request.
 * @param spec - the step's spawn spec.
 * @returns the transport's request shape.
 */
export function agySpawnRequest(spec: AgySpawnSpec): CliSpawnRequest {
  return { argv: agyArgv(spec), cwd: spec.cwd, env: spec.env, signal: spec.signal }
}
