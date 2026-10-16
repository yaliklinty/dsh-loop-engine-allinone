/**
 * Qoder CN CLI process projection.
 *
 * The driver locates the `qoderclicn` executable, builds the argv for one step,
 * and hands the child back as a transport. Qoder's CLI is a Claude-Code-lineage
 * tool, so its non-interactive surface is the one that dialect converges on:
 * `-p` for one shot, `--output-format stream-json` for framing, and
 * `--permission-mode` for the stance.
 *
 * ## What was verified, and how
 *
 * `docs/probes/qoderclicn.md` records the raw captures. In short, against
 * `qoderclicn 1.1.56` on this machine:
 *
 *  - `qoderclicn -p "…"` prints the plain answer and exits 0;
 *  - `qoderclicn -p --output-format stream-json "…"` prints NDJSON whose frames
 *    carry `type`/`subtype`/`session_id`/`message` — Claude Code's dialect,
 *    including a `system`/`init` document naming `qodercli_version 1.1.56` and
 *    `protocol_version 1.5.0`.
 *
 * Two consequences are load-bearing rather than cosmetic:
 *
 *  - The prompt travels as an ARGV argument, so the child needs no stdin pipe.
 *    Requesting one anyway would leave a pipe the child never reads.
 *  - The CLI writes hook chatter (`hook_started`, `hook_progress`,
 *    `hook_response`) onto the same stream. The adapter drops those documents;
 *    see `src/driver-cli/stream-json.ts` for why dropping is the right answer
 *    rather than an omission.
 *
 * @module dsh-loop-engine/engine-qoderclicn/process
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DshApprovalPolicy, DshSandboxMode } from '../driver-core/permission-knobs.ts'
import type { CliSpawnRequest } from '../driver-cli/transport.ts'

/** Grace in milliseconds for Qoder process-tree termination. */
export const QODERCLICN_DISPOSE_GRACE_MS = 3000

/** The CLI's own permission modes, as `--permission-mode` accepts them. */
export const QODERCLICN_PERMISSION_MODES = [
  'default',
  'accept_edits',
  'bypass_permissions',
  'dont_ask',
  'auto',
] as const

/** One Qoder permission mode. */
export type QoderclicnPermissionMode = (typeof QODERCLICN_PERMISSION_MODES)[number]

/** Resolve the Qoder CN home directory from `QODER_HOME` or the current user's home. */
export function qoderclicnHomeDir(): string {
  const envHome = process.env.QODER_HOME
  return envHome !== undefined && envHome !== '' ? envHome : join(homedir(), '.qoder-cn')
}

/**
 * Resolve the `qoderclicn` executable.
 *
 * An explicit config path wins. Otherwise the CLI's own documented install
 * location is probed (`<qoder home>/bin/qoderclicn/qoderclicn[.exe]`, which is
 * where `qoderclicn update` puts it) and PATH is the last resort. The probe
 * matters because Qoder's installer adds `.qoder-cn/bin/qoderclicn` to PATH
 * itself, and a profile launched by a desktop app does not always inherit that.
 * @param configBin - an operator-pinned path, if any.
 * @returns the executable to spawn as `argv[0]`.
 */
export function qoderclicnBinResolver(configBin?: string): string {
  if (configBin !== undefined && configBin !== '') return configBin
  const executable = process.platform === 'win32' ? 'qoderclicn.exe' : 'qoderclicn'
  const candidate = join(qoderclicnHomeDir(), 'bin', 'qoderclicn', executable)
  return existsSync(candidate) ? candidate : 'qoderclicn'
}

/**
 * Map the session's dsh permission knobs onto Qoder's `--permission-mode`.
 *
 * The mapping follows the plugin's fail-closed rule rather than inventing a
 * permissive default:
 *
 *  - `danger-full-access` → `bypass_permissions`, the only mode that matches
 *    "the user said everything is allowed";
 *  - `workspace-write` → `accept_edits`, which lets file edits through while
 *    leaving the CLI's own gate in front of everything else;
 *  - anything else, INCLUDING no knobs at all → `default`, the CLI's own gate.
 *
 * The `ask` approval policy is deliberately NOT mapped to a permissive mode.
 * Qoder's CLI can ask a human, but this driver has no channel to forward that
 * question to dsh's approval seam — the child is unattended. So an `ask` policy
 * degrades to the CLI's own non-interactive behaviour rather than to a silent
 * yes, and the effective boundary stays the subprocess sandbox the whole child
 * is spawned under.
 * @param sandbox - the session's durable sandbox mode, if any.
 * @param approval - the session's durable approval policy, if any.
 * @returns the mode to pass.
 */
export function qoderclicnPermissionMode(
  sandbox: DshSandboxMode | undefined,
  approval: DshApprovalPolicy | undefined,
): QoderclicnPermissionMode {
  if (sandbox === 'danger-full-access') return 'bypass_permissions'
  if (sandbox === 'workspace-write') return 'accept_edits'
  // `approval` is accepted for symmetry with the other engines' resolvers and so
  // the signature does not have to change when a forwarding channel appears.
  void approval
  return 'default'
}

/** Everything one step's Qoder child needs. */
export interface QoderclicnSpawnSpec {
  /** The resolved executable (`argv[0]`). */
  readonly bin: string
  /** The prompt, passed as an argv argument (Qoder reads no stdin in `-p` mode). */
  readonly prompt: string
  /** The session's working directory. */
  readonly cwd: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Pinned model, when the deployment or the session named one. */
  readonly model: string | undefined
  /** Resolved permission mode. */
  readonly permissionMode: QoderclicnPermissionMode
  /** Cancellation. */
  readonly signal: AbortSignal
}

/**
 * Build the argv for one non-interactive Qoder step.
 *
 * `--output-format stream-json` is what makes the answer structured; without it
 * the CLI prints prose and the driver would have to guess where a tool call
 * began. `--no-session-persistence` is deliberately NOT passed: the plugin
 * replays the whole transcript into each prompt, so the CLI's own session store
 * is dead weight, but disabling it also disables `--resume`, which a deployment
 * may want later.
 * @param spec - the step's spawn spec.
 * @returns the argv.
 */
export function qoderclicnArgv(spec: QoderclicnSpawnSpec): string[] {
  return [
    spec.bin,
    '-p',
    '--output-format', 'stream-json',
    '--permission-mode', spec.permissionMode,
    ...spec.model === undefined ? [] : ['--model', spec.model],
    spec.prompt,
  ]
}

/**
 * Project one step's spawn spec onto the transport request.
 * @param spec - the step's spawn spec.
 * @returns the transport's request shape.
 */
export function qoderclicnSpawnRequest(spec: QoderclicnSpawnSpec): CliSpawnRequest {
  return { argv: qoderclicnArgv(spec), cwd: spec.cwd, env: spec.env, signal: spec.signal }
}
