/**
 * The shared runtime base for every external-CLI engine.
 *
 * Each engine's own `loop.ts` used to carry the same four lines of ceremony:
 * resolve the subprocess service, throw a loud engine-specific error if the
 * profile has none, and build a spawn capability that remembers the termination
 * grace period and whether the prompt travels on stdin. That is identical for
 * every CLI engine, so it lives here, and an engine's runtime is left with the
 * two things that are actually its own: how to read its composition-entry knobs,
 * and how to construct its agent.
 *
 * The subprocess service is still resolved LAZILY (at construction, not at
 * plugin apply), which is the original drivers' deliberate choice and is
 * preserved here: an engine is built only when a session actually selects it, so
 * a profile without the subprocess service fails THAT session loud instead of
 * stalling the whole plugin at boot.
 *
 * @module dsh-loop-engine-allinone/driver-cli/cli-loop
 */

import type { Context } from '@deepseek-ai/cordis'
import { HostedEngineRuntime } from '../driver-core/hosted-engine-runtime.ts'
import type { HostedAgent } from '../driver-core/hosted-engine-runtime.ts'
import type { CliSpawnCapability } from './transport.ts'
import { cliSpawner } from './transport.ts'

/**
 * One CLI engine's creation/resume machinery.
 *
 * `TConfig` is the engine's own resolved configuration and `TAgent` its agent;
 * the spawn capability is owned here so a subclass never has to thread it.
 */
export abstract class CliEngineRuntime<TConfig, TAgent extends HostedAgent>
  extends HostedEngineRuntime<TConfig, TAgent> {
  /**
   * The engine's spawn capability: the dsh subprocess seam with this engine's
   * grace period and stdin decision already applied.
   */
  protected readonly spawn: CliSpawnCapability

  /**
   * @param ctx - the owning context.
   * @param label - effect-label prefix, e.g. `agentLoopQoderclicn`.
   * @param config - already-resolved engine configuration.
   * @param engine - the engine id, for the "needs the subprocess service" diagnostic.
   * @param graceMs - grace period for process-tree termination.
   * @param pipeStdin - whether this engine reads its prompt from the child's stdin.
   */
  constructor(
    ctx: Context,
    label: string,
    config: TConfig,
    engine: string,
    graceMs: number,
    pipeStdin: boolean,
  ) {
    super(ctx, label, config)
    // Read structurally rather than through a static `inject`: cordis's service
    // read on an uninjected context throws, and a CLI engine must fail its OWN
    // session rather than the plugin. `ctx.get` is the unguarded read.
    const subprocess = ctx.get('subprocess') as { spawn: (spec: never) => never } | undefined
    if (subprocess === undefined) {
      throw new Error(`loop-engine: the ${engine} engine needs the dsh subprocess service on this context`)
    }
    this.spawn = cliSpawner(
      spec => subprocess.spawn(spec as never),
      graceMs,
      pipeStdin,
    )
  }
}
