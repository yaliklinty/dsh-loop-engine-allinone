/**
 * Antigravity agent: one `agy --input-format stream-json --output-format
 * stream-json --print=` child per dsh step, with the durable session log as the
 * sole source of model context.
 *
 * The engine-specific surface is `runStep`: serialize the transcript, write it to
 * the child's stdin as one NDJSON user message, decode the `event`-tagged reply
 * stream, and let the shared sink write the durable log. See
 * `./process.ts` for the argument-position trap that shapes the argv and for the
 * one protocol fact the probe could not reach (a signed-in host was unavailable),
 * and `./frames.ts` for how the mapper stays correct under both worlds.
 *
 * @module dsh-loop-engine/engine-agy/agent
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { HostedEngineId } from '../engine-registry.ts'
import { ENGINE_REGISTRY } from '../engine-registry.ts'
import { CliHostedAgent, type CliAgentHost } from '../driver-cli/cli-agent.ts'
import type { SinkPosition } from '../driver-cli/session-sink.ts'
import { runNdjson } from '../driver-cli/ndjson.ts'
import { unsupportedImagesRefusal } from '../driver-cli/capability.ts'
import type { CliSpawnCapability } from '../driver-cli/transport.ts'
import type { CliFrame } from '../driver-cli/frames.ts'
import { engineSlashPrompt, serializeHistory } from '../driver-core/prompt.ts'
import { sessionSandboxMode } from '../driver-core/permission-knobs.ts'
import {
  currentSelection,
  foreignHostedModelRefusal,
  modelForStep,
} from '../driver-core/session-model.ts'
import type { SessionModelSelection, SessionProjectionsService } from '../driver-core/host-servers.ts'
import type { AgyEffort, AgyMode, AgySpawnSpec } from './process.ts'
import { agyDangerouslySkipPermissions, agySpawnRequest, agyStdinPrompt } from './process.ts'
import { mapAgyDocument, newAgyRun } from './frames.ts'

/** Deployment-resolved configuration for the Antigravity engine. */
export interface ResolvedAgyConfig {
  /** Pinned auto-approve flag, overriding the session's dsh knobs. */
  readonly dangerouslySkipPermissions: boolean | undefined
  /** Pinned executable, when the deployment named one. */
  readonly bin: string | undefined
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Pinned model. */
  readonly model: string | undefined
  /** Pinned execution mode. */
  readonly mode: AgyMode | undefined
  /** Pinned reasoning effort. */
  readonly effort: AgyEffort | undefined
  /** Pinned sandbox flag, overriding the session's knobs. */
  readonly sandbox: boolean | undefined
}

/** The engine id this driver registers under. */
export const AGY_ENGINE: HostedEngineId = 'agy'

/** Drives one session through turn and step boundaries on Antigravity. */
export class AgyAgent extends CliHostedAgent {
  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    private readonly config: ResolvedAgyConfig,
    private readonly spawn: CliSpawnCapability,
  ) {
    const host: CliAgentHost = { engine: AGY_ENGINE, model: config.model, env: config.env }
    super(loopCtx, id, options, session, host)
    this.installTransportTeardown()
  }

  protected override async runStep(
    messages: readonly UserMessage[],
    position: SinkPosition,
    signal: AbortSignal,
  ): Promise<{ kind: 'completed' } | null> {
    const refusal = unsupportedImagesRefusal(messages, ENGINE_REGISTRY[AGY_ENGINE])
    if (refusal !== undefined) throw new Error(refusal)
    const cwd = this.session.header.cwd
    if (cwd === undefined || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory — start the session with cwd metadata`)
    }
    const history = this.history()
    const prompt = engineSlashPrompt(history) ?? serializeHistory(history, this.imageAccess)
    if (prompt.length === 0) {
      throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`)
    }
    this.assertRequestHeader()

    // The model this step runs: a pick from Antigravity's own catalog (the menu
    // group `agy` in the model selector) outranks the deployment's pin, which
    // outranks the CLI's own default. A pick belonging to ANOTHER engine's
    // catalog is refused rather than ignored — the menu is host-global, so that
    // is reachable, and dropping it would leave the seat naming a model that is
    // not in force.
    const selection = this.selection()
    const foreign = foreignHostedModelRefusal(selection, AGY_ENGINE, ENGINE_REGISTRY[AGY_ENGINE].label)
    if (foreign !== undefined) throw new Error(foreign)
    const model = modelForStep(selection, AGY_ENGINE, this.config.model)

    const spec: AgySpawnSpec = {
      bin: this.config.bin ?? 'agy',
      prompt,
      cwd,
      env: this.config.env,
      model,
      mode: this.config.mode,
      effort: this.config.effort,
      sandbox: this.config.sandbox ?? this.sandboxRequested(),
      dangerouslySkipPermissions: this.config.dangerouslySkipPermissions
        ?? agyDangerouslySkipPermissions(sessionSandboxMode(this.session.snapshotEvents())),
      signal,
    }
    const transport = this.spawn(agySpawnRequest(spec))
    const run = newAgyRun()
    const accept = (frame: CliFrame): void => { this.sink.accept(frame, position) }
    const result = await runNdjson(
      {
        transport,
        // One NDJSON user message, then close stdin: the CLI runs a turn per
        // line and waits, so a stdin left open would hang the step.
        stdin: agyStdinPrompt(prompt),
        map: document => mapAgyDocument(document, accept, run),
      },
      () => {},
    )
    if (result.parsed === 0) {
      accept({
        kind: 'error',
        message: 'agy produced no stream-json on its protocol channel'
          + `${result.lastUnparsed === undefined ? '' : `; last line: ${result.lastUnparsed.slice(0, 200)}`}`,
      })
    }
    const outcome = this.sink.finish(position)
    if (outcome.kind === 'failed') throw new Error(outcome.message)
    return { kind: 'completed' }
  }

  /**
   * The session's current model selection, read the way the host reads it.
   * @returns the selection, or undefined when the log records none.
   */
  private selection(): SessionModelSelection | undefined {
    return currentSelection(
      this.session,
      this.loopCtx.get('sessionProjections') as SessionProjectionsService | undefined,
    )
  }

  /**
   * Whether the child should run with terminal restrictions (`--sandbox`).
   *
   * Antigravity's `--sandbox` restricts the CLI's own terminal use, which is not
   * the same thing as the permission switch (see
   * `agyDangerouslySkipPermissions`). It is requested whenever the session is NOT
   * at full access: the subprocess seam already bounds the child, and asking the
   * CLI to restrict itself as well is the fail-closed direction.
   * @returns whether to pass `--sandbox`.
   */
  private sandboxRequested(): boolean {
    return sessionSandboxMode(this.session.snapshotEvents()) !== 'danger-full-access'
  }
}
