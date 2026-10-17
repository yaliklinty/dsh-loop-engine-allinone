/**
 * MiniMax Code loop engine module: drives every session it is handed through a
 * persistent `mcode acp` child (Agent Client Protocol over stdio), speaking one
 * stateless `session/new` + `session/prompt` per dsh step, with the durable
 * session log as the sole source of model context. The router routes a session
 * here on the plugin's own engine record, else its agent preset; this module is a
 * library, not a Cordis plugin entry.
 *
 * The engine's SUBSCRIPTION is what this driver is for: the plugin never logs in
 * and never touches credentials — the user runs `mcode login --region …` once and
 * `mcode provider use token-plan` to spend the M Plan allowance, and the region
 * reaches the child as the environment variable the CLI reads
 * ({@link Config.region}).
 *
 * Everything below the dialect is the shared ACP runtime
 * (`driver-acp/runtime.ts`).
 *
 * @module dsh-loop-engine/engine-minimaxcode
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AcpResolvedConfig } from '../driver-acp/profile.ts'
import { AcpEngineRuntime } from '../driver-acp/runtime.ts'
import { descriptorOf, regionOf } from '../engine-registry.ts'
import { MinimaxcodeAgent } from './agent.ts'
import { minimaxcodeProfile } from './profile.ts'
import { MINIMAXCODE_DISPOSE_GRACE_MS, mcodeBinResolver } from './process.ts'

/** Deployment-owned configuration for the MiniMax Code engine. */
export interface Config {
  /** Model sent per ACP session (`session/set_config_option`) when the session selects none. */
  model?: string
  /**
   * Explicit environment entries passed to the child.
   *
   * Usually empty on purpose: MiniMax Code reads its own region-scoped
   * credentials from `~/.minimax`. Setting the region variable here is rejected
   * when it disagrees with {@link Config.region}, so the one knob that owns the
   * region is always unambiguous.
   */
  env?: Record<string, string>
  /** The `mcode` entrypoint (an absolute path), resolved from the npm prefixes then PATH when not pinned. */
  bin?: string
  /**
   * The account region the child runs under (`cn` or `global`, default `cn`).
   *
   * It is a real deployment fact rather than a preference: the CLI's login
   * endpoint and its stored credentials are BOTH region-scoped, so a child told
   * the wrong region cannot see the account the user signed in with. It travels in
   * the environment variable the registry row names
   * (`region.envVar`, measured as `MAVIS_REGION` — NOT `MCODE_REGION`, which is
   * inert on this path).
   */
  region?: string
  /** Idle window in milliseconds before a session's ACP child is shut down; zero or less keeps it. */
  childIdleMs?: number
}

/** Schema of the MiniMax Code engine configuration. */
export const Config: z<Config> = z.object({
  model: z.string(),
  env: z.dict(z.string()).default({}),
  bin: z.string(),
  region: z.string(),
  childIdleMs: z.number(),
})

/**
 * Resolve the driver configuration at the plugin config boundary.
 * @param config - the deployment's knobs.
 * @returns the configuration the shared ACP runtime consumes.
 * @throws when the deployment pins a region the CLI does not accept, or pins one
 *   in `env` that contradicts {@link Config.region}.
 */
export function resolveConfig(config: Config): AcpResolvedConfig {
  const descriptor = descriptorOf('minimaxcode')
  const region = regionOf('minimaxcode', config.region)
  const env = { ...config.env }
  const envVar = descriptor.region?.envVar
  if (region !== undefined && envVar !== undefined) {
    const pinned = env[envVar]
    if (pinned !== undefined && pinned !== '' && pinned !== region) {
      throw new Error(
        `loop-engine: ${descriptor.label} is configured with region "${region}" but env.${envVar} is "${pinned}" — set one of them`,
      )
    }
    // The region is spelled into the child's environment because `mcode acp`
    // takes no region flag: the variable is the CLI's own way to select it.
    env[envVar] = region
  }
  return {
    model: config.model,
    env,
    bin: mcodeBinResolver(config.bin),
    childIdleMs: config.childIdleMs ?? 0,
  }
}

/** Host-face ctx key this engine's runtime is registered under. */
export const MINIMAXCODE_ENGINE_LABEL = 'agentLoopMinimaxcode'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoopMinimaxcode: MinimaxcodeLoop
  }
}

/**
 * Creation/resume machinery for the MiniMax Code engine. The process-wide
 * AgentFactory slot belongs to the router, which delegates each session to the
 * engine its preset names; this class is that engine's driver, not a plugin.
 */
export class MinimaxcodeLoop extends AcpEngineRuntime<MinimaxcodeAgent> {
  constructor(ctx: Context, config: Config) {
    const resolved = resolveConfig(config)
    super(ctx, MINIMAXCODE_ENGINE_LABEL, resolved, minimaxcodeProfile(resolved.bin), MINIMAXCODE_DISPOSE_GRACE_MS)
  }

  /** Construct the MiniMax Code ACP driver for one prepared session. */
  protected override buildAgent(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): MinimaxcodeAgent {
    return new MinimaxcodeAgent(loopCtx, id, options, session, this.config, this.spawn, this.config.bin)
  }
}
