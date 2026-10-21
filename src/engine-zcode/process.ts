/**
 * ZCode CLI process projection.
 *
 * ZCode is the Z.AI (GLM) coding CLI. It ships as a Node bundle at
 * `resources/glm/zcode.cjs` inside the ZCode desktop app, so `argv[0]` is
 * usually `process.execPath` and `argv[1]` the script — which is why the
 * resolver returns an argv PREFIX rather than a single path.
 *
 * ## Why this driver uses the one-shot `-p` surface
 *
 * ZCode advertises two machine-facing surfaces. The `zcode app-server` JSON-RPC
 * stdio server is real — the CLI bundle carries its whole method table
 * (`startup/*`, `session/create`, `session/send`, `session/setModel`, …) — but
 * its request parameter shape could not be probed, and writing one from the
 * method names alone is guessing. `zcode -p "prompt"` is the documented surface
 * and, with `--json`, returns a machine-readable result:
 *
 * ```json
 * { "sessionId": "sess_…", "traceId": "…", "turnId": "…", "response": "…",
 *   "usage": { "inputTokens": 10, "outputTokens": 2, … }, "eventCount": 11 }
 * ```
 *
 * (measured on CLI 0.16.9 against a local Anthropic-compatible mock). The driver
 * still treats stdout as the answer rather than parsing that envelope: the
 * documented print mode prints the answer, and a text read is what every
 * `--json`-less run produces.
 *
 * ## Where the provider selection actually lives
 *
 * A headless run reads its provider table from the file named by
 * `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (`~/.zcode/v2/provider_config.json` by
 * default), NOT from `~/.zcode/v2/config.json` and NOT from the desktop app's
 * SQLite. `config.defaultModelSelection` names the provider/model. That is the
 * seam `./model-handover.ts` writes; see that module for the measured document
 * shape and the two-env-var requirement.
 *
 * @module dsh-loop-engine-allinone/engine-zcode/process
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliSpawnRequest } from '../driver-cli/transport.ts'

/** Grace in milliseconds for ZCode process-tree termination. */
export const ZCODE_DISPOSE_GRACE_MS = 3000

/** The `--mode` values the CLI accepts. */
export const ZCODE_MODES = ['build', 'edit', 'plan', 'yolo'] as const

/** One ZCode permission mode. */
export type ZcodeMode = (typeof ZCODE_MODES)[number]

/**
 * The install roots a ZCode desktop build may sit under, most specific first.
 *
 * One list, used by both the CLI lookup and the provider-catalog lookup, so the two
 * can never disagree about where an install is. No drive letter is assumed: the fork
 * was written against one machine's `D:\Programs\ZCode`, and `%ZCODE_HOME%` is how an
 * operator names a manual install like that one.
 * @param env - the environment to read the roots from.
 * @returns candidate roots.
 */
export function zcodeInstallRoots(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const roots: string[] = []
  if (env.ZCODE_HOME !== undefined && env.ZCODE_HOME !== '') roots.push(env.ZCODE_HOME)
  if (env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA !== '') {
    roots.push(join(env.LOCALAPPDATA, 'Programs', 'ZCode'))
  }
  if (process.platform === 'win32' && env.ProgramFiles !== undefined && env.ProgramFiles !== '') {
    roots.push(join(env.ProgramFiles, 'ZCode'))
  }
  return roots
}

/**
 * Every place a ZCode desktop install may keep its bundled CLI, in probe order.
 *
 * Derived from the environment rather than hardcoded: the fork was written against
 * one machine's `D:\Programs\ZCode`, and shipping that literal meant the probe
 * never matched anywhere else. `%LOCALAPPDATA%\Programs` is where the installer puts
 * a per-user app, `%ProgramFiles%` where an all-users install goes, and
 * `%ZCODE_HOME%` is the app's own override.
 * @param env - the environment to read install roots from.
 * @returns candidate paths for the bundled CLI, most specific first.
 */
export function zcodeCliCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return zcodeInstallRoots(env).map(root => join(root, 'resources', 'glm', 'zcode.cjs'))
}

/**
 * The first ZCode bundle found in a plausible install location.
 *
 * @param env - the environment to probe.
 * @returns the resolved script, or undefined when no install was found.
 */
function wellKnownZcode(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const candidate of zcodeCliCandidates(env)) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the argv prefix that launches ZCode.
 *
 * Three shapes, and the difference is why this returns an array: a pinned `.cjs`
 * path runs under the current node (the bundled form), a pinned native binary is
 * spawned directly, and with nothing pinned the well-known bundle is used before
 * falling back to a `zcode` on PATH.
 * @param configBin - an operator-pinned executable or script, if any.
 * @returns the argv prefix ending in the ZCode entrypoint.
 */
export function zcodeArgvPrefix(configBin?: string): string[] {
  const pinned = configBin === undefined || configBin === '' ? wellKnownZcode() : configBin
  if (pinned === undefined) return ['zcode']
  return /\.(?:c|m)?js$/i.test(pinned) ? [process.execPath, pinned] : [pinned]
}

/**
 * The environment entry the bundled ZCode needs to find its own provider
 * catalog.
 *
 * Discovered by the probe: run outside the desktop app, the bundle reports
 * `无法定位 CLI ZCode Built-in Provider Config` and refuses to start a turn until
 * this variable points at the app's own `zcode-builtin.json`. The driver sets it
 * only when the deployment has not — an explicit deployment value always wins.
 */
export const ZCODE_PROVIDER_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'

/**
 * Every place a ZCode install may keep the provider catalog its bundle needs.
 * @param env - the environment to read install roots from.
 * @returns candidate paths, most specific first.
 */
export function zcodeProviderConfigCandidates(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return zcodeInstallRoots(env).map(root => join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'))

}

/**
 * The bundled provider catalog inside the desktop app, when it exists.
 * @param env - the environment to probe.
 * @returns the catalog path, or undefined when no install was found.
 */
export function zcodeBuiltinProviderConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const candidate of zcodeProviderConfigCandidates(env)) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Map the session's dsh knobs onto ZCode's `--mode`.
 *
 * Fail-closed like the other engines: full access is the only thing that earns
 * `yolo`; everything else, including "no knobs at all", gets the CLI's own
 * `build` mode, and the subprocess sandbox remains the real boundary.
 * @param sandbox - the session's durable sandbox mode, if any.
 * @returns the mode to pass.
 */
export function zcodeMode(dangerFullAccess: boolean): ZcodeMode {
  return dangerFullAccess ? 'yolo' : 'build'
}

/** Everything one step's ZCode child needs. */
export interface ZcodeSpawnSpec {
  /** The argv prefix ending in the entrypoint. */
  readonly prefix: readonly string[]
  /** The prompt, passed as an argv argument. */
  readonly prompt: string
  /** The session's working directory. */
  readonly cwd: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Resolved permission mode. */
  readonly mode: ZcodeMode
  /** Cancellation. */
  readonly signal: AbortSignal
}

/**
 * Build the argv for one non-interactive ZCode step.
 *
 * No model flag: ZCode 0.16.9 rejects `--model` (`Unknown option '--model'`) and
 * takes the model from the provider document its environment names — the seam
 * `./model-handover.ts` uses for a dsh model, and the user's own
 * `defaultModelSelection` when no handover is in force.
 * @param spec - the step's spawn spec.
 * @returns the argv.
 */
export function zcodeArgv(spec: ZcodeSpawnSpec): string[] {
  return [
    ...spec.prefix,
    '-p', spec.prompt,
    '--mode', spec.mode,
    '--no-color',
  ]
}

/**
 * Project one step's spawn spec onto the transport request.
 *
 * The provider-catalog variable is merged UNDER the deployment's own entries, so
 * an explicit `env` always wins over the discovered default.
 * @param spec - the step's spawn spec.
 * @param providerConfig - the discovered catalog path, if any.
 * @returns the transport's request shape.
 */
export function zcodeSpawnRequest(spec: ZcodeSpawnSpec, providerConfig: string | undefined): CliSpawnRequest {
  return {
    argv: zcodeArgv(spec),
    cwd: spec.cwd,
    env: {
      ...providerConfig === undefined ? {} : { [ZCODE_PROVIDER_CONFIG_ENV]: providerConfig },
      ...spec.env,
    },
    signal: spec.signal,
  }
}
