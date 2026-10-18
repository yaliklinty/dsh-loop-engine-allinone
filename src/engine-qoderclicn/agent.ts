/**
 * Qoder CN agent: one `qoderclicn -p … --output-format stream-json` child per
 * dsh step, with the durable session log as the sole source of model context.
 *
 * The whole engine-specific surface is {@link QoderclicnAgent.runStep}: serialize
 * the transcript, spawn, decode the NDJSON dialect, and let the shared sink write
 * the durable log. Everything else — the turn loop, the inbox, cancellation, the
 * step rotation, the tool-call/result pairing — is inherited from
 * {@link CliHostedAgent}.
 *
 * ## Why one child per step
 *
 * Qoder's `-p` is inherently one-shot: it answers and exits. That suits this
 * plugin's model exactly, because the plugin is stateless by design — every step
 * replays the durable transcript as the prompt, so nothing is lost by not
 * carrying a session across steps, and nothing leaks between them either. The
 * cost is process startup per step, which is what `capabilities.sessionResume`
 * describes rather than hides.
 *
 * @module dsh-loop-engine-allinone/engine-qoderclicn/agent
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { HostedEngineId } from '../engine-registry.ts'
import { CliHostedAgent, type CliAgentHost } from '../driver-cli/cli-agent.ts'
import type { SinkPosition } from '../driver-cli/session-sink.ts'
import { runNdjson } from '../driver-cli/ndjson.ts'
import { mapStreamJsonDocument } from '../driver-cli/stream-json.ts'
import type { CliSpawnCapability } from '../driver-cli/transport.ts'
import type { CliFrame } from '../driver-cli/frames.ts'
import { engineSlashPrompt, serializeHistory } from '../driver-core/prompt.ts'
import { unsupportedImagesRefusal } from '../driver-cli/capability.ts'
import { ENGINE_REGISTRY } from '../engine-registry.ts'
import { sessionApprovalPolicy, sessionSandboxMode } from '../driver-core/permission-knobs.ts'
import type { QoderclicnSpawnSpec } from './process.ts'
import type { QoderclicnPermissionMode } from './process.ts'
import { qoderclicnPermissionMode, qoderclicnSpawnRequest } from './process.ts'

/** Deployment-resolved configuration for the Qoder engine. */
export interface ResolvedQoderclicnConfig {
  /** Pinned executable, when the deployment named one. */
  readonly bin: string | undefined
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Pinned model, when the deployment named one. */
  readonly model: string | undefined
  /** Pinned permission mode, overriding the session's knobs. */
  readonly permissionMode: string | undefined
}

/** The engine id this driver registers under. */
export const QODERCLICN_ENGINE: HostedEngineId = 'qoderclicn'

/**
 * Drives one session through turn and step boundaries on Qoder CN.
 *
 * Named for the engine rather than generically so a stack trace says which
 * driver failed; the shared machinery it inherits is what makes the class this
 * small.
 */
export class QoderclicnAgent extends CliHostedAgent {
  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    private readonly config: ResolvedQoderclicnConfig,
    private readonly spawn: CliSpawnCapability,
  ) {
    const host: CliAgentHost = {
      engine: QODERCLICN_ENGINE,
      model: config.model,
      env: config.env,
    }
    super(loopCtx, id, options, session, host)
    this.installTransportTeardown()
  }

  protected override async runStep(
    messages: readonly UserMessage[],
    position: SinkPosition,
    signal: AbortSignal,
  ): Promise<{ kind: 'completed' } | null> {
    const cwd = this.session.header.cwd
    if (cwd === undefined || cwd.length === 0) {
      throw new Error(`agent "${this.id}": no working directory — start the session with cwd metadata`)
    }
    // Refuse rather than silently drop: Qoder's non-interactive surface has no
    // image channel this build verified, and accepting the attachment while
    // sending only text would look to the user like the engine saw the picture.
    const refusal = unsupportedImagesRefusal(messages, ENGINE_REGISTRY[QODERCLICN_ENGINE])
    if (refusal !== undefined) throw new Error(refusal)
    const history = this.history()
    // A live slash command is the engine's own control line: send it verbatim,
    // so the CLI expands it rather than handing the raw `/name` to the model as
    // prose. Qoder's CLI expands commands only when the prompt opens with `/`.
    const slash = engineSlashPrompt(history)
    const prompt = slash ?? serializeHistory(history, this.imageAccess)
    if (prompt.length === 0) {
      throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`)
    }
    this.assertRequestHeader()

    const spec: QoderclicnSpawnSpec = {
      bin: this.config.bin ?? 'qoderclicn',
      prompt,
      cwd,
      env: this.config.env,
      model: this.config.model,
      permissionMode: this.permissionMode(),
      signal,
    }
    const transport = this.spawn(qoderclicnSpawnRequest(spec))

    const run = { sessionId: undefined as string | undefined, reportedError: undefined as string | undefined }
    const accept = (frame: CliFrame): void => { this.sink.accept(frame, position) }
    const result = await runNdjson(
      { transport, map: document => mapDocument(document, accept, run) },
      /* v8 ignore start -- the mapper pushes frames straight to `accept` rather than returning them, so this collector is never called; the run signature requires one */
      () => {},
      /* v8 ignore stop */
    )
    // A child that printed NOTHING parseable did not speak the protocol: that is
    // a startup failure (a missing binary, an unsigned login, a flag the
    // installed version does not know), and reporting it as an empty answer
    // would be the silent degradation this plugin exists not to produce.
    if (result.parsed === 0) {
      this.sink.accept({
        kind: 'error',
        message: `qoderclicn produced no stream-json on its protocol channel`
          + `${result.lastUnparsed === undefined ? '' : `; last line: ${result.lastUnparsed.slice(0, 200)}`}`,
      }, position)
    }
    const outcome = this.sink.finish(position)
    // A failed run is thrown, not returned: the turn's own ending must say the
    // engine failed, and the base classifies a thrown error as `turn/end`
    // `error` while carrying the engine's own words into the log. Returning
    // `{kind:'completed'}` after a reported failure would be exactly the
    // silent-success bug this plugin exists not to ship.
    if (outcome.kind === 'failed') throw new Error(outcome.message)
    return { kind: 'completed' }
  }

  /** Resolve the permission mode for this step: the pin wins, else the session's knobs. */
  private permissionMode(): QoderclicnPermissionMode {
    if (this.config.permissionMode !== undefined) {
      return this.config.permissionMode as QoderclicnPermissionMode
    }
    const events = this.session.snapshotEvents()
    return qoderclicnPermissionMode(sessionSandboxMode(events), sessionApprovalPolicy(events))
  }
}

/**
 * Map one document, accumulating the run's session id and verdict.
 *
 * Split out so the accumulation object is created once per run rather than
 * captured per document — the adapter mutates it, and a fresh object per line
 * would throw the session id away.
 * @param document - the parsed document.
 * @param accept - frame sink.
 * @param run - the run accumulator.
 * @returns the frames to accept — empty, because the adapter pushes directly.
 */
function mapDocument(
  document: unknown,
  accept: (frame: CliFrame) => void,
  run: { sessionId: string | undefined; reportedError: string | undefined },
): readonly CliFrame[] {
  mapStreamJsonDocument(document, accept, run)
  return []
}
