/**
 * Hermes Agent CLI process projection.
 *
 * Hermes is a Python CLI whose non-interactive surface is `hermes chat -q
 * "prompt" --oneshot`. With `--format stream-json` that run emits a documented
 * JSONL event stream (`hermes_cli/stream_json.py`: `system/init`, `text`,
 * `tool_use`, `tool_result`, `result`) instead of plain prose, which is what
 * `./frames.ts` maps. The old `-z` shortcut printed only the final answer, so it
 * could never show the engine's tool calls.
 *
 * ## The environment, which is the interesting part
 *
 * Hermes keeps ALL of its state under `HERMES_HOME` (this machine: a directory
 * outside the user profile holding 147 sessions, 105 skills and `auth.json`).
 * The plugin never reads, writes or forwards that path — the child inherits it
 * from the ambient environment like any other variable, because the dsh
 * subprocess seam's scrub only removes `DSH_*` facts and names matching
 * `KEY|PASSWORD|SECRET|TOKEN`, and `HERMES_HOME` matches neither.
 *
 * That inheritance is a FEATURE and not an accident worth leaving untested: if
 * the plugin ever blanket-replaced the child environment, every Hermes session
 * would silently start against an empty `HERMES_HOME` — a fresh install with no
 * login — and the failure would look like "the model is broken" rather than
 * "the plugin dropped an environment variable". `tests/engine-hermes/process.spec.ts`
 * pins it.
 *
 * @module dsh-loop-engine-allinone/engine-hermes/process
 */

import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { CliSpawnRequest } from '../driver-cli/transport.ts'

/** Grace in milliseconds for Hermes process-tree termination. */
export const HERMES_DISPOSE_GRACE_MS = 3000

/** The single-query flag of Hermes' `chat` subcommand. */
export const HERMES_PROMPT_FLAG = '-q'

/** The environment variable holding Hermes' entire state directory. */
export const HERMES_HOME_ENV = 'HERMES_HOME'

/**
 * The well-known install location of the Hermes CLI on Windows, for the case
 * where a desktop-launched profile did not inherit the PATH entry its installer
 * added.
 */
function wellKnownHermes(): string | undefined {
  /* v8 ignore start -- the POSIX arm cannot run on this project's Windows CI host */
  if (process.platform !== 'win32') return undefined
  /* v8 ignore stop */
  const local = process.env.LOCALAPPDATA
  /* v8 ignore start -- an absent LOCALAPPDATA is the "no per-user Hermes install" state, and the fallback is the same story one line down */
  if (local === undefined || local === '') return undefined
  /* v8 ignore stop */
  const candidate = join(local, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Resolve the `hermes` executable.
 *
 * An explicit config path wins; then the well-known venv location; then PATH.
 * The venv probe exists because that is where Hermes' own installer puts the
 * CLI, and a profile started from a desktop shortcut does not always see the
 * PATH entry pointing at it.
 * @param configBin - an operator-pinned path, if any.
 * @returns the executable to spawn as `argv[0]`.
 */
export function hermesBinResolver(configBin?: string): string {
  if (configBin !== undefined && configBin !== '') return configBin
  return wellKnownHermes() ?? 'hermes'
}

/**
 * Whether a PATH entry looks like it could hold a `hermes` executable.
 *
 * Exported because the diagnostic surface (the settings page's engine check)
 * wants to report "found on PATH" without spawning anything.
 * @param pathEnv - the PATH value to inspect.
 * @returns whether any entry names an existing `hermes` file.
 */
export function hermesOnPath(pathEnv: string | undefined): boolean {
  if (pathEnv === undefined || pathEnv === '') return false
  /* v8 ignore start -- the POSIX arm cannot run on this project's Windows CI host */
  const names = process.platform === 'win32' ? ['hermes.exe', 'hermes.cmd', 'hermes.bat'] : ['hermes']
  /* v8 ignore stop */
  for (const entry of pathEnv.split(delimiter)) {
    if (entry === '') continue
    for (const name of names) {
      if (existsSync(join(entry, name))) return true
    }
  }
  return false
}

/** Everything one step's Hermes child needs. */
export interface HermesSpawnSpec {
  /** The resolved executable (`argv[0]`). */
  readonly bin: string
  /** The prompt, passed as an argv argument. */
  readonly prompt: string
  /** The session's working directory. */
  readonly cwd: string
  /**
   * Explicit environment entries layered over the scrubbed parent environment.
   *
   * Deliberately usually EMPTY: Hermes needs no forwarded credential, because
   * it reads its own `HERMES_HOME` (inherited) and its own `auth.json`. A
   * deployment may still add entries here, and one that sets `HERMES_HOME`
   * explicitly overrides the inherited value — which is how a user points the
   * plugin at a second Hermes profile.
   */
  readonly env: Record<string, string>
  /** Pinned model, when the deployment or the session named one. */
  readonly model: string | undefined
  /**
   * Provider id the argv must name, when a dsh endpoint was handed over.
   *
   * Present only for a handover: Hermes' own configuration decides the provider
   * otherwise (`--provider custom` would re-select the user's own vendor table,
   * which is exactly what the handover replaces).
   */
  readonly provider: string | undefined
  /** Pinned reasoning level, when the deployment named one. */
  readonly reasoning: string | undefined
  /** Cancellation. */
  readonly signal: AbortSignal
}

/**
 * Build the argv for one non-interactive Hermes step.
 * @param spec - the step's spawn spec.
 * @returns the argv.
 */
export function hermesArgv(spec: HermesSpawnSpec): string[] {
  return [
    spec.bin,
    'chat',
    HERMES_PROMPT_FLAG, spec.prompt,
    '--oneshot',
    '--format', 'stream-json',
    ...spec.provider === undefined ? [] : ['--provider', spec.provider],
    ...spec.model === undefined ? [] : ['-m', spec.model],
    ...spec.reasoning === undefined ? [] : ['--reasoning', spec.reasoning],
  ]
}

/**
 * Project one step's spawn spec onto the transport request.
 * @param spec - the step's spawn spec.
 * @returns the transport's request shape.
 */
export function hermesSpawnRequest(spec: HermesSpawnSpec): CliSpawnRequest {
  return { argv: hermesArgv(spec), cwd: spec.cwd, env: spec.env, signal: spec.signal }
}
