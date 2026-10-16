/**
 * Hermes Agent loop engine module: drives every session it is handed through one
 * `hermes -z "prompt"` child per dsh step, with the durable session log as the
 * sole source of model context. The router routes a session here on the plugin's
 * own engine record, else its agent preset; this module is a library, not a
 * Cordis plugin entry.
 *
 * Hermes has no permission-mode switch this driver maps, so the effective
 * boundary is the dsh subprocess sandbox the whole child is spawned under
 * (default read-only).
 *
 * @module dsh-loop-engine/engine-hermes
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CliEngineRuntime } from '../driver-cli/cli-loop.ts'
import { HermesAgent, HERMES_ENGINE, type ResolvedHermesConfig } from './agent.ts'
import { HERMES_DISPOSE_GRACE_MS, hermesBinResolver } from './process.ts'

/** Deployment-owned configuration for the Hermes Agent engine. */
export interface Config {
  /** Model for the CLI (`-m`); Hermes' own configuration owns the model when omitted. */
  model?: string
  /**
   * Explicit environment entries passed to the child.
   *
   * Usually empty on purpose: Hermes reads its own `HERMES_HOME` and `auth.json`
   * from the INHERITED environment. Setting `HERMES_HOME` here is how a
   * deployment points the plugin at a second Hermes profile.
   */
  env?: Record<string, string>
  /** The `hermes` executable; PATH (and the CLI's own venv location) when not pinned. */
  bin?: string
  /** Reasoning level (`--reasoning`). */
  reasoning?: string
}

/** Schema of the Hermes Agent engine configuration. */
export const Config: z<Config> = z.object({
  model: z.string(),
  env: z.dict(z.string()).default({}),
  bin: z.string(),
  reasoning: z.string(),
})

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedHermesConfig {
  return {
    bin: config.bin === undefined || config.bin === '' ? undefined : hermesBinResolver(config.bin),
    env: config.env ?? {},
    model: config.model,
    reasoning: config.reasoning,
  }
}

/** Host-face ctx key this engine's runtime is registered under. */
export const HERMES_ENGINE_LABEL = 'agentLoopHermes'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopHermes: HermesLoop
  }
}

/**
 * Creation/resume machinery for the Hermes Agent engine. The process-wide
 * AgentFactory slot belongs to the router, which delegates each session to the
 * engine its preset names; this class is that engine's driver, not a plugin.
 */
export class HermesLoop extends CliEngineRuntime<ResolvedHermesConfig, HermesAgent> {
  constructor(ctx: Context, config: Config) {
    // The prompt travels as an argv argument (`-z …`), so the child gets no
    // stdin pipe.
    super(ctx, HERMES_ENGINE_LABEL, resolveConfig(config), HERMES_ENGINE, HERMES_DISPOSE_GRACE_MS, false)
  }

  /** Construct the Hermes driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): HermesAgent {
    return new HermesAgent(loopCtx, id, options, session, this.config, this.spawn)
  }
}
