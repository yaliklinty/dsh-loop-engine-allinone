/**
 * Grok Build loop engine module: drives every session it is handed through a
 * persistent `grok agent stdio` child (Agent Client Protocol over stdio), speaking
 * one stateless `session/new` + `session/prompt` per dsh step, with the durable
 * session log as the sole source of model context. The router routes a session
 * here on the plugin's own engine record, else its agent preset; this module is a
 * library, not a Cordis plugin entry.
 *
 * Everything below the dialect is the shared ACP runtime
 * (`driver-acp/runtime.ts`); grok contributes its argv, its protocol version (from
 * the registry row) and the `authenticate`-then-`session/new` handshake its own
 * ACP server requires.
 *
 * @module dsh-loop-engine/engine-grok
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AcpEngineRuntime } from '../driver-acp/runtime.ts'
import { GrokAgent } from './agent.ts'
import { grokProfile } from './profile.ts'
import { GROK_DISPOSE_GRACE_MS, grokBinResolver } from './process.ts'
import type { AcpResolvedConfig } from '../driver-acp/profile.ts'

/** Deployment-owned configuration for the Grok Build engine. */
export interface Config {
  /** Model sent per ACP session (`session/set_config_option`) when the session selects none. */
  model?: string
  /**
   * Explicit environment entries passed to the child.
   *
   * Usually empty on purpose: Grok reads its own `~/.grok/auth.json` (or
   * `XAI_API_KEY`) from the INHERITED environment, and `GROK_HOME` is how a
   * deployment points it at a second profile.
   */
  env?: Record<string, string>
  /** The `grok` executable (or its npm shim); the vendor install location, then PATH, when not pinned. */
  bin?: string
  /** Idle window in milliseconds before a session's ACP child is shut down; zero or less keeps it. */
  childIdleMs?: number
}

/** Schema of the Grok Build engine configuration. */
export const Config: z<Config> = z.object({
  model: z.string(),
  env: z.dict(z.string()).default({}),
  bin: z.string(),
  childIdleMs: z.number(),
})

/** Resolve the driver configuration at the plugin config boundary. */
export function resolveConfig(config: Config): AcpResolvedConfig {
  return {
    model: config.model,
    env: config.env ?? {},
    bin: grokBinResolver(config.bin),
    childIdleMs: config.childIdleMs ?? 0,
  }
}

/** Host-face ctx key this engine's runtime is registered under. */
export const GROK_ENGINE_LABEL = 'agentLoopGrok'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopGrok: GrokLoop
  }
}

/**
 * Creation/resume machinery for the Grok Build engine. The process-wide
 * AgentFactory slot belongs to the router, which delegates each session to the
 * engine its preset names; this class is that engine's driver, not a plugin.
 */
export class GrokLoop extends AcpEngineRuntime<GrokAgent> {
  constructor(ctx: Context, config: Config) {
    const resolved = resolveConfig(config)
    super(ctx, GROK_ENGINE_LABEL, resolved, grokProfile(resolved.bin), GROK_DISPOSE_GRACE_MS)
  }

  /** Construct the Grok ACP driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): GrokAgent {
    return new GrokAgent(loopCtx, id, options, session, this.config, this.spawn, this.config.bin)
  }
}
