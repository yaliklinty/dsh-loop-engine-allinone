/**
 * Grok Build's loop Agent: the shared ACP body with the dialect in `./profile.ts`.
 *
 * The class is this engine's published driver shape (and the seam a
 * grok-specific behaviour would land on); the dialect itself — argv, protocol
 * version, model selection, session handshake — lives in `./profile.ts`, which
 * imports no host service so it can be exercised by `scripts/probe/smoke-acp.ts`
 * against the real CLI.
 *
 * @module dsh-loop-engine-allinone/engine-grok/agent
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { AcpResolvedConfig } from '../driver-acp/profile.ts'
import type { AcpSpawnCapability } from '../driver-acp/transport.ts'
import { AcpEngineAgent } from '../driver-acp/agent.ts'
import { grokProfile } from './profile.ts'

export { grokProfile }

/** Grok Build's loop Agent: the shared ACP body with the profile's dialect. */
export class GrokAgent extends AcpEngineAgent {
  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    config: AcpResolvedConfig,
    spawn: AcpSpawnCapability,
    bin: string = config.bin,
  ) {
    super(loopCtx, id, options, session, config, spawn, grokProfile(bin))
  }
}
