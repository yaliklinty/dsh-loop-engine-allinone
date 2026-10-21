/**
 * ZCode agent: one `zcode -p "prompt"` child per dsh step, with the durable
 * session log as the sole source of model context.
 *
 * Like the Hermes driver this reads stdout as a finished answer, and the reason
 * is the same shape of fact recorded in `./process.ts`: the structured
 * app-server surface exists but its request parameter shape could not be probed,
 * so the driver uses the surface that is verified to reach the model rather than
 * guessing a protocol.
 *
 * ZCode additionally needs its provider catalog located: run outside the desktop
 * app the bundled CLI refuses to start a turn until
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` points at the app's own copy. The driver
 * supplies the discovered default; a deployment's explicit `env` wins.
 *
 * A session that selects a REAL dsh model is handed over through ZCode's own
 * personal-provider document (`./model-handover.ts`), written beside — never
 * over — the user's `~/.zcode` settings and removed when the step ends.
 *
 * @module dsh-loop-engine-allinone/engine-zcode/agent
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
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
import { sessionSandboxMode } from '../driver-core/permission-knobs.ts'
import { resolveModelHandover } from '../driver-core/model-handover.ts'
import { sessionModelOverrideOf, unservableModelRefusal } from '../driver-core/session-model.ts'
import {
  ZCODE_PERSONAL_PROVIDER_CONFIG_ENV,
  removeZcodePersonalProviderConfig,
  writeZcodePersonalProviderConfig,
} from './model-handover.ts'
import type { ZcodeSpawnSpec } from './process.ts'
import { zcodeArgvPrefix, zcodeBuiltinProviderConfig, zcodeMode, zcodeSpawnRequest } from './process.ts'

/** Deployment-resolved configuration for the ZCode engine. */
export interface ResolvedZcodeConfig {
  /** The argv prefix ending in the entrypoint. */
  readonly prefix: readonly string[]
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Pinned model. */
  readonly model: string | undefined
  /** The discovered bundled provider catalog, when present. */
  readonly providerConfig: string | undefined
}

/** The engine id this driver registers under. */
export const ZCODE_ENGINE: HostedEngineId = 'zcode'

/** Drives one session through turn and step boundaries on ZCode. */
export class ZcodeAgent extends CliHostedAgent {
  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    private readonly config: ResolvedZcodeConfig,
    private readonly spawn: CliSpawnCapability,
  ) {
    const host: CliAgentHost = { engine: ZCODE_ENGINE, model: config.model, env: config.env }
    super(loopCtx, id, options, session, host)
    this.installTransportTeardown()
  }

  protected override async runStep(
    messages: readonly UserMessage[],
    position: SinkPosition,
    signal: AbortSignal,
  ): Promise<{ kind: 'completed' } | null> {
    const refusal = unsupportedImagesRefusal(messages, ENGINE_REGISTRY[ZCODE_ENGINE])
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
    // endpoint and credential. A real dsh model ZCode cannot be handed is refused
    // HERE, before a child is spawned: forwarding the name to the engine's own
    // provider table is the cryptic failure this replaces.
    const override = sessionModelOverrideOf(this.loopCtx, this.session)
    const resolved = await resolveModelHandover(this.loopCtx, override)
    const unservable = unservableModelRefusal(override, ENGINE_REGISTRY[ZCODE_ENGINE].label)
    if (resolved === undefined && unservable !== undefined) throw new LlmError(unservable, 'UNSERVABLE_MODEL')

    // ZCode's only seam for a custom provider is a file path, so the handover is
    // one private document per step. The user's own `~/.zcode` is neither read as
    // configuration nor written to: the file lives in a fresh temp directory and
    // is removed when the step ends, success or failure.
    let handoverFile: string | undefined
    let env = this.config.env
    if (resolved !== undefined) {
      handoverFile = await writeZcodePersonalProviderConfig(resolved)
      env = { ...env, [ZCODE_PERSONAL_PROVIDER_CONFIG_ENV]: handoverFile }
    }

    try {
      const spec: ZcodeSpawnSpec = {
        prefix: this.config.prefix,
        prompt,
        cwd,
        env,
        mode: zcodeMode(sessionSandboxMode(this.session.snapshotEvents()) === 'danger-full-access'),
        signal,
      }
      const result = await runText({ transport: this.spawn(zcodeSpawnRequest(spec, this.config.providerConfig)) })
      const outcome = textRunOutcome(result)
      if (outcome.kind === 'failed') throw new Error(outcome.message)
      this.sink.commitWholeMessage(outcome.text, undefined, position)
      const finished = this.sink.finish(position)
      if (finished.kind === 'failed') throw new Error(finished.message)
      return { kind: 'completed' }
    } finally {
      if (handoverFile !== undefined) {
        // A failed cleanup must not replace the step's own outcome; the file is
        // in the OS temp directory and a later run never reuses this path.
        try {
          await removeZcodePersonalProviderConfig(handoverFile)
        } catch {
          // Swallowed on purpose: the step already has its answer or its error.
        }
      }
    }
  }
}

/** Re-exported so `./loop.ts` does not have to know how the prefix is built. */
export { zcodeArgvPrefix, zcodeBuiltinProviderConfig }
