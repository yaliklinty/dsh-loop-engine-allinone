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
import { runNdjson } from '../driver-cli/ndjson.ts'
import type { CliFrame } from '../driver-cli/frames.ts'
import { unsupportedImagesRefusal } from '../driver-cli/capability.ts'
import type { CliSpawnCapability } from '../driver-cli/transport.ts'
import { engineSlashPrompt, serializeHistory } from '../driver-core/prompt.ts'
import { resolveModelHandover } from '../driver-core/model-handover.ts'
import { sessionModelOverrideOf, unservableModelRefusal } from '../driver-core/session-model.ts'
import { mapHermesDocument, newHermesRun } from './frames.ts'
import type { HermesSpawnSpec } from './process.ts'
import { hermesSpawnRequest } from './process.ts'
import { hermesHandover } from './model-handover.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'


/** Read a child's stderr to EOF; an absent stream is the empty string. */
async function readStderr(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  /* v8 ignore start -- the subprocess seam always supplies stderr */
  if (stream === undefined) return ''
  /* v8 ignore stop */
  let text = ''
  for await (const chunk of stream) text += String(chunk)
  return text
}

/** Await a child's exit without letting a rejected wait replace the engine's verdict. */
async function exitCodeOf(done: Promise<unknown>): Promise<number | null | undefined> {
  try {
    const value = await done as { exitCode?: number | null } | undefined
    return value?.exitCode
  } catch {
    /* v8 ignore start -- a killed child is reported by the step's own outcome */
    return undefined
    /* v8 ignore stop */
  }
}

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

    // The session's model selection, and — when dsh discloses it — that model's
    // endpoint and credential. A real dsh model Hermes cannot be handed is refused
    // HERE, before a child is spawned: forwarding the name to an engine whose
    // provider table has never heard of it is the cryptic failure this replaces.
    const override = sessionModelOverrideOf(this.loopCtx, this.session)
    const resolved = await resolveModelHandover(this.loopCtx, override)
    const unservable = unservableModelRefusal(override, ENGINE_REGISTRY[HERMES_ENGINE].label)
    if (resolved === undefined && unservable !== undefined) throw new LlmError(unservable, 'UNSERVABLE_MODEL')
    const handover = resolved === undefined ? undefined : hermesHandover(resolved)

    const spec: HermesSpawnSpec = {
      bin: this.config.bin ?? 'hermes',
      prompt,
      cwd,
      // A handover rides the child environment, so the user's own HERMES_HOME —
      // sessions, skills, auth.json — stays in force for this session.
      env: handover === undefined ? this.config.env : { ...this.config.env, ...handover.env },
      model: handover?.model ?? this.config.model,
      provider: handover?.provider,
      reasoning: this.config.reasoning,
      signal,
    }
    const transport = this.spawn(hermesSpawnRequest(spec))
    const run = newHermesRun()
    const accept = (frame: CliFrame): void => { this.sink.accept(frame, position) }
    const result = await runNdjson(
      { transport, map: document => mapHermesDocument(document, accept, run) },
      /* v8 ignore start -- the mapper pushes frames straight to `accept` rather than returning them, so this collector is never called; the run signature requires one */
      () => {},
      /* v8 ignore stop */
    )
    const [stderr, code] = await Promise.all([
      readStderr(transport.stderr),
      exitCodeOf(transport.done),
    ])
    if (result.parsed === 0) {
      const detail = stderr.trim()
      const message = code !== undefined && code !== 0
        ? detail !== '' ? detail : `hermes exited with code ${code}`
        : `hermes produced no stream-json on its protocol channel`
          + `${result.lastUnparsed === undefined ? '' : `; last line: ${result.lastUnparsed.slice(0, 200)}`}`
      this.sink.accept({ kind: 'error', message }, position)
    }
    const finished = this.sink.finish(position)
    if (finished.kind === 'failed') throw new Error(finished.message)
    return { kind: 'completed' }
  }
}
