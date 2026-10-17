/**
 * MiniMax Code's ACP dialect: the shared ACP body with mcode's own handshake.
 *
 * Measured against MiniMax Code 0.6.12 on this fork's reference host (raw frames
 * with `scripts/probe/acp-handshake.mjs`), and the reason each hook below exists:
 *
 *   1. `initialize` answers `protocolVersion: 1`, advertises NO auth method (the
 *      CLI reads its own `~/.minimax/auth/prod/<region>/…` state and its
 *      subscription is chosen with `mcode provider use token-plan`), and reports
 *      `promptCapabilities.image: true` — so this engine does receive image blocks;
 *   2. `session/new` succeeds WITHOUT a prior `authenticate` and answers a
 *      `sessionId`, ACP `modes` (`default`/`plan`), and `configOptions` for
 *      `permissionMode`, `model` and `thinkingEffort`. The model ids are the
 *      engine's own composite form (`m:minimax:MiniMax-M3:v:thinking`);
 *   3. a model or permission is changed with `session/set_config_option` and a BARE
 *      value (`value: 'm:…'`) — the `{ value }` wrapper that Grok's documentation
 *      shows is REJECTED here with `-32602 Invalid params`. `session/set_model`
 *      does not exist on this engine at all (`-32601 Method not found`), which is
 *      why the shared driver's model selection is a profile hook;
 *   4. `session/load` is accepted, so engine-side resume exists even though this
 *      driver replays the durable transcript and opens a fresh session per step.
 *
 * ## The permission fold
 *
 * The engine's `permissionMode` option is its own gate (`default` = Ask,
 * `auto` = Auto, `bypassPermissions` = Full access). The driver maps the session's
 * dsh approval knob onto it only where the knob is decisive — `never` becomes
 * `bypassPermissions` and `ask` becomes `default` — and otherwise LEAVES the
 * engine's own default alone (`auto`), rather than inventing a policy the user
 * never chose. Whatever the engine still asks for arrives as the reverse-RPC
 * `session/request_permission`, answered by the shared fold.
 *
 * @module dsh-loop-engine/engine-minimaxcode/profile
 */

import { acpDefaultApproval } from '../driver-acp/approval.ts'
import type { AcpEngineProfile } from '../driver-acp/profile.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import { sessionApprovalPolicy } from '../driver-core/permission-knobs.ts'
import { acpProtocolVersionOf } from '../engine-registry.ts'
import { mcodeAcpArgv } from './process.ts'

/** The engine's model config option id, as `session/new` advertises it. */
export const MCODE_MODEL_CONFIG_ID = 'model'

/** The engine's tool-permission config option id (category `_permission`). */
export const MCODE_PERMISSION_CONFIG_ID = 'permissionMode'

/**
 * The engine's `permissionMode` value for one session's dsh approval knob.
 *
 * ALWAYS decisive, never "leave the engine's default alone". That default is not
 * a safe resting state: `session/new` on this engine reports the option's
 * `currentValue` from whatever the CLI last persisted in `~/.minimax/config.yaml`,
 * and a previous run — including a probe, measured on this fork's reference
 * host — can leave `bypassPermissions` there. A driver that only spoke when the
 * knob was decisive would then inherit Full access for a session that asked for
 * nothing of the sort.
 *
 * The mapping itself follows the shared fold's semantics:
 *   - `never` (auto-approve) means the human is not in the loop at all, so the
 *     engine is told its most permissive mode rather than asking a gate that
 *     would always answer yes;
 *   - `ask` means there IS no human in the unattended runtime, so the engine's Ask
 *     mode is selected and the reverse-RPC fold denies — fail-closed, exactly like
 *     the kimi and codex bridges;
 *   - an unset knob is not a choice, so the engine's own middle mode is selected:
 *     it may still ask, and the fold (which approves under this policy) answers.
 *
 * KNOWN SIDE EFFECT, documented rather than hidden: this option is
 * process-scoped, and the engine persists it, so setting it here rewrites the
 * user's `~/.minimax/config.yaml`. Stating the mode per session is the price of
 * never inheriting a stale Full-access default.
 * @param session - the session whose durable knobs are read.
 * @returns the `permissionMode` value to set.
 */
export function mcodePermissionMode(session: Session): string {
  const policy = sessionApprovalPolicy(session.snapshotEvents())
  if (policy === 'never') return 'bypassPermissions'
  if (policy === 'ask') return 'default'
  return 'auto'
}

/** MiniMax Code's ACP dialect, as the shared driver reads it. */
export function minimaxcodeProfile(bin: string): AcpEngineProfile {
  return {
    engine: 'minimaxcode',
    label: 'minimaxcode',
    errorCode: 'MINIMAXCODE_NO_RESULT',
    protocolVersion: acpProtocolVersionOf('minimaxcode'),
    argv: () => mcodeAcpArgv(bin),
    // Measured: `promptCapabilities.image: true`.
    images: true,
    approve: acpDefaultApproval,
    // Measured: the BARE value form is the one this engine accepts.
    selectModel: async (client, sessionId, model) => { await client.setConfigOption(sessionId, MCODE_MODEL_CONFIG_ID, model) },
    openSession: async (client, cwd, session) => {
      const sessionId = await client.newSession(cwd)
      // Set unconditionally: the engine's own default is whatever it last
      // persisted, which is why {@link mcodePermissionMode} always has an answer.
      // The option is declared process-scoped, so it is set once per opened
      // session; a failure here fails the step loud rather than silently running a
      // permission stance the session never asked for.
      await client.setConfigOption(sessionId, MCODE_PERMISSION_CONFIG_ID, mcodePermissionMode(session))
      return sessionId
    },
  }
}
