/**
 * Qoder CN loop engine module: drives every session it is handed through one
 * `qoderclicn -p --output-format stream-json` child per dsh step, with the
 * durable session log as the sole source of model context. The router routes a
 * session here on the plugin's own engine record, else its agent preset; this
 * module is a library, not a Cordis plugin entry.
 *
 * Qoder's CLI has a permission-mode switch but no channel this driver can
 * forward a human approval question through, so the effective boundary is the
 * dsh subprocess sandbox the whole child is spawned under (default read-only)
 * plus the mode mapped in `./process.ts`.
 *
 * @module dsh-loop-engine/engine-qoderclicn
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CliEngineRuntime } from '../driver-cli/cli-loop.ts'
import { QoderclicnAgent, QODERCLICN_ENGINE, type ResolvedQoderclicnConfig } from './agent.ts'
import { QODERCLICN_DISPOSE_GRACE_MS, qoderclicnBinResolver } from './process.ts'

/** Deployment-owned configuration for the Qoder CN engine. */
export interface Config {
  /** Model for the CLI (`--model`); Qoder's own configuration owns the model when omitted. */
  model?: string
  /** Explicit environment entries passed to the child. */
  env?: Record<string, string>
  /** The `qoderclicn` executable; PATH (and the CLI's own install dir) when not pinned. */
  bin?: string
  /** Pinned permission mode, overriding the session's dsh permission knobs. */
  permissionMode?: string
}

/** Schema of the Qoder CN engine configuration. */
export const Config: z<Config> = z.object({
  model: z.string(),
  env: z.dict(z.string()).default({}),
  bin: z.string(),
  permissionMode: z.string(),
})

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedQoderclicnConfig {
  return {
    bin: config.bin === undefined || config.bin === '' ? undefined : qoderclicnBinResolver(config.bin),
    env: config.env ?? {},
    model: config.model,
    permissionMode: config.permissionMode,
  }
}

/** Host-face ctx key this engine's runtime is registered under. */
export const QODERCLICN_ENGINE_LABEL = 'agentLoopQoderclicn'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopQoderclicn: QoderclicnLoop
  }
}

/**
 * Creation/resume machinery for the Qoder CN engine. The process-wide
 * AgentFactory slot belongs to the router, which delegates each session to the
 * engine its preset names; this class is that engine's driver, not a plugin.
 */
export class QoderclicnLoop extends CliEngineRuntime<ResolvedQoderclicnConfig, QoderclicnAgent> {
  constructor(ctx: Context, config: Config) {
    // The prompt travels as an argv argument (`-p …`), so the child gets no
    // stdin pipe: asking for one would leave a pipe it never reads.
    super(ctx, QODERCLICN_ENGINE_LABEL, resolveConfig(config), QODERCLICN_ENGINE, QODERCLICN_DISPOSE_GRACE_MS, false)
  }

  /** Construct the Qoder driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): QoderclicnAgent {
    return new QoderclicnAgent(loopCtx, id, options, session, this.config, this.spawn)
  }
}
