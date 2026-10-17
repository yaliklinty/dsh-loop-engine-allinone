/**
 * The shared tool-approval fold for ACP engines.
 *
 * An ACP agent surfaces a tool it wants to run as the reverse-RPC
 * `session/request_permission`, which the client MUST answer; the dsh harness has
 * no interactive approval callback in the unattended runtime, so the fold has to
 * decide. It mirrors the codex/Pi bridges: an `ask` policy degrades to a denial
 * (the only safe answer when no human is present), and anything else (`never`, or
 * a knob-less session) auto-approves.
 *
 * It lives here rather than in one engine's directory because all three ACP
 * engines arrive at the same gate; an engine whose own permission switch already
 * bounds the tool can still override the fold through its profile's `approve`.
 *
 * @module dsh-loop-engine-allinone/driver-acp/approval
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { sessionApprovalPolicy } from '../driver-core/permission-knobs.ts'

/**
 * Whether the driver should answer `session/request_permission` with approval for
 * one query. An `ask` policy denies; anything else auto-approves. The sandbox
 * stance is not consulted: the engine's own tool policy bounds what a tool does,
 * and the ACP approval is the host's gate, signalled by `approval/policy`.
 * @param session - the session whose durable knobs are read.
 * @returns whether tool requests are approved.
 */
export function acpDefaultApproval(session: Session): boolean {
  return sessionApprovalPolicy(session.snapshotEvents()) !== 'ask'
}
