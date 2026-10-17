/**
 * ZCode loop engine module: drives every session it is handed through one
 * `zcode -p "prompt"` child per dsh step, with the durable session log as the
 * sole source of model context. The router routes a session here on the plugin's
 * own engine record, else its agent preset; this module is a library, not a
 * Cordis plugin entry.
 *
 * See `./process.ts` for why this driver uses ZCode's one-shot print surface
 * rather than its JSON-RPC app-server, and what was and was not verified.
 *
 * @module dsh-loop-engine-allinone/engine-zcode
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CliEngineRuntime } from '../driver-cli/cli-loop.ts'
import { ZcodeAgent, ZCODE_ENGINE, type ResolvedZcodeConfig } from './agent.ts'
import { ZCODE_DISPOSE_GRACE_MS, zcodeArgvPrefix, zcodeBuiltinProviderConfig } from './process.ts'

/** Deployment-owned configuration for the ZCode engine. */
export interface Config {
  /** Model label (`--model`); ZCode's own settings own the model when omitted. */
  model?: string
  /** Explicit environment entries passed to the child; these win over the discovered ones. */
  env?: Record<string, string>
  /** The `zcode` entrypoint (a `.cjs` bundle or a native binary); auto-discovered when not pinned. */
  bin?: string
}

/** Schema of the ZCode engine configuration. */
export const Config: z<Config> = z.object({
  model: z.string(),
  env: z.dict(z.string()).default({}),
  bin: z.string(),
})

/** Resolve the driver configuration at the plugin config boundary. */
function resolveConfig(config: Config): ResolvedZcodeConfig {
  return {
    prefix: zcodeArgvPrefix(config.bin),
    env: config.env ?? {},
    model: config.model,
    providerConfig: zcodeBuiltinProviderConfig(),
  }
}

/** Host-face ctx key this engine's runtime is registered under. */
export const ZCODE_ENGINE_LABEL = 'agentLoopZcode'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopZcode: ZcodeLoop
  }
}

/**
 * Creation/resume machinery for the ZCode engine. The process-wide AgentFactory
 * slot belongs to the router, which delegates each session to the engine its
 * preset names; this class is that engine's driver, not a plugin.
 */
export class ZcodeLoop extends CliEngineRuntime<ResolvedZcodeConfig, ZcodeAgent> {
  constructor(ctx: Context, config: Config) {
    // The prompt travels as an argv argument (`-p …`), so the child gets no
    // stdin pipe.
    super(ctx, ZCODE_ENGINE_LABEL, resolveConfig(config), ZCODE_ENGINE, ZCODE_DISPOSE_GRACE_MS, false)
  }

  /** Construct the ZCode driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): ZcodeAgent {
    return new ZcodeAgent(loopCtx, id, options, session, this.config, this.spawn)
  }
}
