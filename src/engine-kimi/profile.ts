/**
 * Kimi Code's ACP driver: the shared ACP body plus kimi's own dialect.
 *
 * Kimi was the engine the shared body grew out of, so its dialect is the
 * baseline: `kimi acp`, protocol version 1, `session/set_model` for model
 * selection, and the one thing no other engine has — a translation of a dsh
 * endpoint handover into the `KIMI_MODEL_*` environment its own env-model path
 * reads.
 *
 * The dialect lives here, apart from the driver class in `./agent.ts`, so it
 * imports no host service: `scripts/probe/smoke-acp.ts` exercises THIS profile
 * (argv, protocol version, model selection, handover) against the real CLI.
 *
 * @module dsh-loop-engine-allinone/engine-kimi/profile
 */

import type { AcpEngineProfile } from '../driver-acp/profile.ts'
import { acpProtocolVersionOf } from '../engine-registry.ts'
import { kimiModelEnv } from './model-handover.ts'
import { kimiAcpArgv } from './process.ts'
import { resolveToolApproval } from './permission.ts'

/** Kimi Code's ACP dialect, as the shared driver reads it. */
export function kimiProfile(bin: string): AcpEngineProfile {
  return {
    engine: 'kimi',
    label: 'kimi',
    errorCode: 'KIMI_NO_RESULT',
    protocolVersion: acpProtocolVersionOf('kimi'),
    argv: () => kimiAcpArgv(bin),
    // Measured on kimi 0.28.x: image blocks ride the prompt; the shared body
    // decides whether to build them (see `AcpEngineProfile.images`).
    images: true,
    // Kimi's fold is the shared one, kept as this engine's own named function so
    // the engine's tests pin kimi's answer directly (see `./permission.ts`).
    approve: session => resolveToolApproval(session.snapshotEvents()),
    // Kimi selects a model per ACP session through `session/set_model`, and the
    // client rejects on an error frame — so a model kimi refuses fails the step
    // loud rather than silently running kimi's own default.
    selectModel: async (client, sessionId, model) => { await client.setModel(sessionId, model) },
    // The whole dsh-endpoint handover is environment for kimi: `KIMI_MODEL_NAME`
    // and its three siblings define one provider and one model alias, without
    // touching `~/.kimi-code/config.toml`.
    handoverEnv: handover => kimiModelEnv(handover),
  }
}
