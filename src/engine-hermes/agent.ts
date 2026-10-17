/**
 * Hermes Agent: one `hermes -z "prompt"` child per dsh step, with the durable
 * session log as the sole source of model context.
 *
 * Hermes is the plugin's plain-text engine. It prints a finished answer and
 * exits, with no frames, no tool events and no usage — so the driver's whole job
 * is: serialize the transcript, spawn, read stdout to completion, and commit it
 * as one assistant message through the shared sink.
 *
 * The consequences are declared rather than papered over
 * (`EngineCapabilities`): `streaming: false` means the UI must not promise
 * token-by-token output, and the absence of tool events means a tool Hermes ran
 * internally appears nowhere in the transcript. That is a faithful record of
 * what the engine reported.
 *
 * @module dsh-loop-engine-allinone/engine-hermes/agent
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { HostedEngineId } from '../engine-registry.ts'
import { ENGINE_REGISTRY } from '../engine-registry.ts'
import { CliHostedAgent, type CliAgentHost } from '../driver-cli/cli-agent.ts'
import type { SinkPosition } from '../driver-cli/session-sink.ts'
import { runText, textRunOutcome } from '../driver-cli/text.ts'
import { unsupportedImagesRefusal } from '../driver-cli/capability.ts'
import type { CliSpawnCapability } from '../driver-cli/transport.ts'
import { engineSlashPrompt, serializeHistory } from '../driver-core/prompt.ts'
import type { HermesSpawnSpec } from './process.ts'
import { hermesSpawnRequest } from './process.ts'

/** Deployment-resolved configuration for the Hermes engine. */
export interface ResolvedHermesConfig {
  /** Pinned executable, when the deployment named one. */
  readonly bin: string | undefined
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Pinned model. */
  readonly model: string | undefined
  /** Pinned reasoning level. */
  readonly reasoning: string | undefined
}

/** The engine id this driver registers under. */
export const HERMES_ENGINE: HostedEngineId = 'hermes'

/** Drives one session through turn and step boundaries on Hermes Agent. */
export class HermesAgent extends CliHostedAgent {
  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    private readonly config: ResolvedHermesConfig,
    private readonly spawn: CliSpawnCapability,
  ) {
    const host: CliAgentHost = { engine: HERMES_ENGINE, model: config.model, env: config.env }
    super(loopCtx, id, options, session, host)
    this.installTransportTeardown()
  }

  protected override async runStep(
    messages: readonly UserMessage[],
    position: SinkPosition,
    signal: AbortSignal,
  ): Promise<{ kind: 'completed' } | null> {
    const refusal = unsupportedImagesRefusal(messages, ENGINE_REGISTRY[HERMES_ENGINE])
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

    const spec: HermesSpawnSpec = {
      bin: this.config.bin ?? 'hermes',
      prompt,
      cwd,
      env: this.config.env,
      model: this.config.model,
      reasoning: this.config.reasoning,
      signal,
    }
    const result = await runText({ transport: this.spawn(hermesSpawnRequest(spec)) })
    const outcome = textRunOutcome(result)
    if (outcome.kind === 'failed') {
      // Thrown rather than committed as an empty answer: the turn's own ending
      // must say the engine failed, and the message is the engine's own stderr.
      throw new Error(outcome.message)
    }
    // A plain-text engine reports no separate reasoning block, so the whole
    // answer is text. `commitWholeMessage` gives it the same durable shape a
    // streaming engine's answer has — one assistant message with a timed (here
    // empty) stream — so the transcript is indistinguishable to a later replay.
    this.sink.commitWholeMessage(outcome.text, undefined, position)
    const finished = this.sink.finish(position)
    if (finished.kind === 'failed') throw new Error(finished.message)
    return { kind: 'completed' }
  }
}
