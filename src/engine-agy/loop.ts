/**
 * Antigravity loop engine module: drives every session it is handed through one
 * `agy` stream-json child per dsh step, with the durable session log as the sole
 * source of model context. The router routes a session here on the plugin's own
 * engine record, else its agent preset; this module is a library, not a Cordis
 * plugin entry.
 *
 * Authentication is entirely the CLI's: the plugin never reads, writes or
 * refreshes Antigravity's Google credential — the child inherits the standard
 * user environment and finds it itself, which is what makes a session run on the
 * user's own subscription rather than on any credential this plugin holds.
 *
 * @module dsh-loop-engine/engine-agy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CliEngineRuntime } from '../driver-cli/cli-loop.ts'
import { AgyAgent, AGY_ENGINE, type ResolvedAgyConfig } from './agent.ts'
import type { AgyEffort, AgyMode } from './process.ts'
import { AGY_DISPOSE_GRACE_MS, AGY_EFFORTS, AGY_MODES, agyBinResolver } from './process.ts'

/** Deployment-owned configuration for the Antigravity engine. */
export interface Config {
  /** Model for the CLI (`--model`); Antigravity's own settings own the model when omitted. */
  model?: string
  /** Explicit environment entries passed to the child. */
  env?: Record<string, string>
  /** The `agy` executable; the CLI's own install location (and PATH) when not pinned. */
  bin?: string
  /** The session's execution mode (`--mode`); defaults to `auto`. */
  mode?: AgyMode
  /** Reasoning effort (`--effort`). */
  effort?: AgyEffort
  /** Pinned terminal-restriction flag, overriding the session's permmission knobs. */
  sandbox?: boolean
}

/** Schema of the Antigravity engine configuration. */
export const Config: z<Config> = z.object({
  model: z.string(),
  env: z.dict(z.string()).default({}),
  bin: z.string(),
  mode: z.union([...AGY_MODES.map(value => z.const(value))]).default('auto'),
  effort: z.union([...AGY_EFFORTS.map(value => z.const(value))]),
  sandbox: z.boolean(),
})

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedAgyConfig {
  return {
    bin: config.bin === undefined || config.bin === '' ? undefined : agyBinResolver(config.bin),
    env: config.env ?? {},
    model: config.model,
    mode: config.mode ?? 'auto',
    effort: config.effort,
    sandbox: config.sandbox,
  }
}

/** Host-face ctx key this engine's runtime is registered under. */
export const AGY_ENGINE_LABEL = 'agentLoopAgy'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopAgy: AgyLoop
  }
}

/**
 * Creation/resume machinery for the Antigravity engine. The process-wide
 * AgentFactory slot belongs to the router, which delegates each session to the
 * engine its preset names; this class is that engine's driver, not a plugin.
 */
export class AgyLoop extends CliEngineRuntime<ResolvedAgyConfig, AgyAgent> {
  constructor(ctx: Context, config: Config) {
    // The prompt travels on the child's stdin (one NDJSON user message), so the
    // spawn requests a stdin pipe.
    super(ctx, AGY_ENGINE_LABEL, resolveConfig(config), AGY_ENGINE, AGY_DISPOSE_GRACE_MS, true)
  }

  /** Construct the Antigravity driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): AgyAgent {
    return new AgyAgent(loopCtx, id, options, session, this.config, this.spawn)
  }
}
