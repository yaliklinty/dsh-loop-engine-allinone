/**
 * The engines' side of the shared ACP driver, as data plus four small hooks.
 *
 * `driver-acp/agent.ts` holds the whole turn/step machine, and this module is
 * everything that varies between the engines that run on it. The split is the
 * same one the registry makes for the driver TABLE (one row per engine, and a
 * new engine adds no branch to shared code): a new ACP engine is a profile, not
 * a copy of a 900-line driver.
 *
 * ## What is a hook here, and why
 *
 * Four engine facts are CALLS rather than data, because each is a conversation
 * with the agent rather than a constant:
 *
 *   - {@link AcpEngineProfile.openSession} — grok refuses `session/new` until the
 *     client authenticates, MiniMax Code does not;
 *   - {@link AcpEngineProfile.selectModel} — kimi takes `session/set_model`,
 *     both new engines take `session/set_config_option` (and the two do not even
 *     agree on that call's parameter SHAPE);
 *   - {@link AcpEngineProfile.handoverEnv} — only kimi can translate a dsh
 *     endpoint into its own environment variables;
 *   - {@link AcpEngineProfile.approve} — the approval fold is a policy, and an
 *     engine whose own permission switch already bounds the tool may answer
 *     differently.
 *
 * `protocolVersion` is deliberately DATA and comes from the engine's registry
 * row (`capabilities.acpProtocolVersion`): the value announced at `initialize`
 * used to be hardcoded in the shared client, which is exactly the protocol-drift
 * risk three engines on one skeleton must not inherit.
 *
 * @module dsh-loop-engine/driver-acp/profile
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { DshModelHandover } from '../driver-core/model-handover.ts'
import type { HostedEngineId } from '../engine-registry.ts'
import type { AcpClient } from './client.ts'

/**
 * One ACP driver's configuration after defaults and load-time validation.
 *
 * Shared because every ACP engine resolves the same four facts; the engines'
 * own `process.ts` modules own the EXECUTABLE, which is what actually differs and
 * what the profile's `argv` consumes.
 */
export interface AcpResolvedConfig {
  /** Model the session selects when it has none of its own; the engine decides when omitted. */
  readonly model: string | undefined
  /** Explicit environment entries layered over the credential-scrubbed parent environment. */
  readonly env: Record<string, string>
  /** The engine's CLI executable (or, for an npm-installed CLI, its entry path). */
  readonly bin: string
  /**
   * How long an idle session keeps its ACP child, in milliseconds; zero or less
   * keeps it for the session's whole life. See `driver-core/idle-child.ts` for
   * why the child, and not the agent, is what gets released.
   */
  readonly childIdleMs: number
}

/** One ACP engine's protocol dialect, as the shared driver reads it. */
export interface AcpEngineProfile {
  /** The registry id, used for the engine's own tool-name vocabulary. */
  readonly engine: HostedEngineId
  /** The engine's name in diagnostics and error messages (`kimi`, `grok`, `minimaxcode`). */
  readonly label: string
  /** The `LlmError` code a step with no assistant output fails with. */
  readonly errorCode: string
  /**
   * The ACP protocol version announced at `initialize`.
   *
   * From the registry row's `capabilities.acpProtocolVersion`; every engine on
   * this fork's reference host answered protocol version 1 to a client that
   * announced 1, which is also the documented default.
   */
  readonly protocolVersion: number
  /** The argv that launches this engine's ACP server, `argv[0]` being the executable. */
  readonly argv: (bin: string) => string[]
  /** Whether the engine accepts image blocks in a prompt (measured per engine). */
  readonly images: boolean
  /**
   * Whether the session's dsh approval knobs approve a reverse-RPC permission
   * request. Absent means the ACP default: approve everything except under an
   * `ask` policy, which the unattended runtime answers with a denial.
   */
  readonly approve?: (session: Session) => boolean
  /**
   * Select the model for one ACP session, in this engine's own dialect.
   *
   * Absent means the engine has no model selection on this surface at all, and
   * the deployment's `model`/the session's pick is dropped rather than sent as a
   * call the agent would reject.
   */
  readonly selectModel?: (client: AcpClient, sessionId: string, model: string) => Promise<void>
  /**
   * Open one ACP session, including whatever handshake the engine requires first.
   *
   * Absent means the plain `session/new` every ACP engine answers.
   */
  readonly openSession?: (
    client: AcpClient,
    cwd: string,
    session: Session,
    initializeResult: unknown,
  ) => Promise<string>
  /**
   * Translate a dsh endpoint handover into this engine's own environment.
   *
   * Absent means the engine owns its provider credential and there is nothing to
   * hand over — the shared driver then never resolves a dsh endpoint for it.
   */
  readonly handoverEnv?: (handover: DshModelHandover) => Record<string, string>
}
