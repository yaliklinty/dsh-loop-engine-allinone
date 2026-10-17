/**
 * Public types of the Kimi Code loop driver. Types only — no runtime code.
 *
 * Kimi Code (`kimi`) has no host approval callback ("runs with the permissions
 * of the user"), and its ACP surface already answers tool approvals through the
 * shared fold. It exposes no `--tools` pruning flag on this surface either, so
 * there is no per-driver permission lever to pin: the driver spawns the whole
 * `kimi acp` child through the dsh subprocess seam — the only available privilege
 * boundary — and the sandbox stance follows the session's durable permission
 * knobs as the subprocess provider resolves them (default read-only).
 *
 * {@link ResolvedConfig} is the shared ACP configuration under this engine's
 * published name: kimi, grok and MiniMax Code resolve the same four facts, so the
 * shape lives once in `driver-acp/profile.ts` instead of three times here.
 *
 * @module dsh-loop-engine/engine-kimi/types
 */

import type { AcpResolvedConfig } from '../driver-acp/profile.ts'

/**
 * Driver configuration after defaults and load-time validation: the model the
 * session selects when it has none, the child's environment, the executable, and
 * the idle window after which the ACP child is released.
 */
export type ResolvedConfig = AcpResolvedConfig
