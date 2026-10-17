/**
 * The runtime half every ACP engine shares: one persistent child, one driver.
 *
 * Extracted from the kimi engine when two more ACP engines landed. It is the
 * same machinery for all of them — hand the driver a spawn capability projected
 * through the dsh subprocess seam (the only privilege boundary available) and
 * let it construct the engine's agent per session. What differs per engine is
 * the profile (the dialect) and the executable resolver, both of which that
 * engine's own `process.ts`/`agent.ts` own.
 *
 * @module dsh-loop-engine-allinone/driver-acp/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { HostedEngineRuntime } from '../driver-core/hosted-engine-runtime.ts'
import { AcpEngineAgent } from './agent.ts'
import type { AcpEngineProfile, AcpResolvedConfig } from './profile.ts'
import { acpSubprocessSpec, fromSubprocess } from './subprocess.ts'
import type { AcpSpawnCapability } from './transport.ts'

// Re-exported so an importer that reached them here (the kimi engine's
// `process.ts`, before this moved) keeps working, and so the seam projection has
// ONE definition rather than a copy per caller.
export { acpSubprocessSpec, fromSubprocess } from './subprocess.ts'

/**
 * Creation/resume machinery for one ACP engine.
 *
 * A plain class, not a Cordis plugin: the process-wide AgentFactory slot belongs
 * to the router, which delegates each session to the engine its preset names.
 * The generic agent parameter is what lets an engine with its own driver class
 * (kimi's `KimiAgent`) keep it while an engine that needs nothing beyond the
 * shared body uses {@link AcpEngineAgent} directly.
 */
export abstract class AcpEngineRuntime<TAgent extends AcpEngineAgent = AcpEngineAgent>
  extends HostedEngineRuntime<AcpResolvedConfig, TAgent> {
  /** One-shot spawn capability handed to every agent, sandboxed by the subprocess seam. */
  readonly spawn: AcpSpawnCapability

  /**
   * @param ctx - the owning context; its fiber's unload tears every live agent down.
   * @param label - effect-label prefix, e.g. `agentLoopKimi`.
   * @param config - this engine's already-resolved configuration.
   * @param profile - this engine's ACP dialect.
   * @param disposeGraceMs - grace for process-tree termination through the seam.
   */
  constructor(
    ctx: Context,
    label: string,
    config: AcpResolvedConfig,
    protected readonly profile: AcpEngineProfile,
    disposeGraceMs: number,
  ) {
    super(ctx, label, config)
    // Resolved lazily rather than injected: this engine is built only when a
    // session actually selects it, so a profile without the subprocess service
    // fails that session loud instead of stalling the whole plugin.
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      throw new Error(`loop-engine: the ${profile.label} engine needs the dsh subprocess service on this context`)
    }
    this.spawn = spec => fromSubprocess(subprocess.spawn(acpSubprocessSpec(spec, disposeGraceMs)))
  }

  /** Construct the driver for one prepared session. */
  protected abstract override buildAgent(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): TAgent
}
