/**
 * The shared CLI agent: the turn/step lifecycle every external-CLI engine runs,
 * in one place.
 *
 * The four original drivers each carry their own copy of this machinery — about
 * 450 near-identical lines apiece (the `jscpd:ignore` markers in
 * `src/engine-<id>/agent.ts` mark exactly that duplication). Keeping those copies
 * was the right call at the time: they were written and hardened one engine at a
 * time, against protocols whose failure modes differed. It is the wrong call for
 * engines added after this refactor, because the machinery is where the subtle
 * bugs live (a missing `agent/error`, a step left open, an inbox claim that
 * never wakes the driver) and a new engine should not have to rediscover them.
 *
 * So a NEW engine implements {@link CliHostedAgent} instead. It supplies:
 *
 *  - {@link CliHostedAgent.runStep} — the protocol round trip, which is the only
 *    part that is actually engine-specific; and
 *  - whatever transport, argv and frame mapping that round trip needs.
 *
 * Everything else — the phase machine, the durable inbox, cancellation, the
 * pre-step waterfall, skill injection, maintenance, the status transitions —
 * is inherited and therefore identical across engines by construction.
 *
 * The durable-log half of a step is {@link SessionSink}, which this base owns
 * and hands to the subclass. The split is deliberate: the base owns *when*
 * things happen (turn opened, step started, step closed), the sink owns *what
 * lands in the log* (messages, tool calls, results, streams), and the subclass
 * owns *what the engine said*.
 *
 * @module dsh-loop-engine-allinone/driver-cli/cli-agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
} from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { HostedEngineId } from '../engine-registry.ts'
import { HOSTED_DEFAULT_MODEL, HOSTED_ROUTE_LABEL } from '../agent-preset-ids.ts'
import { DriverInbox } from '../driver-core/inbox.ts'
import { createImageAccessResolver } from '../driver-core/image-access.ts'
import { SessionSink, type SinkPosition } from './session-sink.ts'
import {
  invokedSkillNames,
  isSkillName,
  renderSkillContent,
  type SkillDefinition,
  type SkillsService,
} from '../driver-core/skill-inject.ts'

/**
 * Provider route label every hosted engine logs into `request/header` and into
 * message provenance — the ONE route they share
 * ({@link HOSTED_ROUTE_LABEL}), so the model menu carries a single `external`
 * group instead of one per engine.
 */
export const CLI_PROVIDER = HOSTED_ROUTE_LABEL

/** One driver's lifecycle phase. */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** The running phase, whose `turn`/`step` follow the step actually open. */
type RunningPhase = Extract<Phase, { kind: 'running' }>

/** What a proposed step decided. */
type PreparedStep = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }

/** The ending a step reports, before the turn loop folds it. */
type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

/**
 * What one subclass needs to tell the base about itself.
 *
 * A small object rather than a long constructor parameter list, because every
 * engine adds fields to it over time and a positional list makes each addition a
 * breaking change for every subclass.
 */
export interface CliAgentHost {
  /** Which engine this agent runs, for tool-name projection and diagnostics. */
  readonly engine: HostedEngineId
  /**
   * The model label logged into `request/header` and message provenance.
   *
   * The engine's own word for "whatever it decides" when the deployment pinned
   * none — it is what makes the session's `(provider, model)` resolve to this
   * plugin's placeholder route entry instead of a composite string naming a
   * model no adapter serves.
   */
  readonly model: string | undefined
  /**
   * The environment entries the child is spawned with, layered over the
   * credential-scrubbed parent environment.
   */
  readonly env: Record<string, string>
}

/**
 * The shared base for every external-CLI engine.
 *
 * Subclasses implement {@link runStep} only. Everything else here is the
 * lifecycle the harness's `Agent` contract requires, written once.
 */
export abstract class CliHostedAgent implements Agent {
  /** The durable inbox, driven from the session's own log. */
  readonly inbox: DriverInbox
  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  /** The agent's own context, carrying the agent in its store. */
  readonly ctx: Context
  /** The shared durable-log writer for this agent's lifecycle. */
  protected readonly sink: SessionSink
  /** Resolves the read-only path behind each image block of the prompt. */
  protected readonly imageAccess: ImageAttachmentAccessResolver

  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private readonly dispatch: AgentEventDispatch
  private requestHeaderLogged = false
  /**
   * Whether a wake was requested while the activity could not accept it.
   *
   * Held on the phase rather than here so it is reset with the phase, which is
   * what makes "the last wake wins" true across a turn boundary.
   */
  constructor(
    /**
     * The context the agent was built on.
     *
     * Protected rather than private: a subclass's protocol round trip needs the
     * same host reads the four original drivers make from this context (the
     * session's model selection, the attachment service), and re-deriving them
     * from the agent-scoped context would be a second, subtly different read.
     */
    protected readonly loopCtx: Context,
    /** This agent's session id. */
    public readonly id: SessionId,
    /** The loop options the session was built with. */
    public readonly options: AgentOptions,
    /** The durable session this agent serves. */
    public readonly session: Session,
    /** Engine facts the base cannot answer for itself. */
    protected readonly hostFacts: CliAgentHost,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new DriverInbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.imageAccess = createImageAccessResolver(loopCtx)
    this.sink = new SessionSink({
      session,
      sessionId: id,
      engine: hostFacts.engine,
      provider: CLI_PROVIDER,
      model: this.modelLabel(),
      dispatch: this.dispatch,
      onStepRotated: (step) => { this.onStepRotated(step) },
    })
  }

  /** The label the session's requests and messages are recorded under. */
  protected modelLabel(): string {
    return this.hostFacts.model ?? HOSTED_DEFAULT_MODEL
  }

  /** The engine this agent runs. */
  protected get engine(): HostedEngineId {
    return this.hostFacts.engine
  }

  /** The environment entries the child is spawned with. */
  protected get env(): Record<string, string> {
    return this.hostFacts.env
  }

  /**
   * Run one step's protocol round trip.
   *
   * The ONLY method a subclass must implement, and the only place an engine is
   * actually different. It is handed the position its frames belong to and must
   * feed them to {@link CliHostedAgent.sink}; returning means the engine
   * settled.
   *
   * A protocol failure (a malformed frame, a child that died mid-run) should
   * throw — the base reports it as the turn's `error` ending. An engine that
   * merely answered badly is NOT a protocol failure: report it through the sink
   * (`{ kind: 'error' }`) and the base turns it into a failed turn with the
   * engine's own words.
   * The return value is the step's own verdict on the turn: `{ kind: 'completed' }`
   * for an ordinary answer, `{ kind: 'max-tokens' }` when the engine hit its
   * output ceiling, or `null` to say the sink's own verdict stands. The turn loop
   * takes the FIRST verdict a step reports and keeps it for the turn.
   * @param messages - the messages this step delivers.
   * @param position - the turn/step the frames belong to.
   * @param signal - cancellation.
   * @returns the step's ending.
   */
  protected abstract runStep(
    messages: readonly UserMessage[],
    position: SinkPosition,
    signal: AbortSignal,
  ): Promise<StepEndReason | null>

  /**
   * Called after the sink rotates to a new step, so a subclass can reset any
   * per-step state it holds.
   * @param step - the step number now open.
   */
  protected onStepRotated(step: number): void {
    void step
  }

  /**
   * Release whatever the subclass opened for the step that just ended.
   *
   * Called from the step's `finally`, so it runs on success, failure and
   * cancellation alike. A driver that spawns per step disposes its child here; a
   * driver holding a persistent child leaves it.
   */
  protected releaseStep(): void {}

  /**
   * The transport's own teardown, when the agent's scope is unwound.
   *
   * Where a persistent child is finally closed. A per-step transport has
   * nothing to do here, because {@link releaseStep} already released it.
   */
  protected disposeTransport(): void {}

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  /**
   * Queue a message for the next turn and wake the driver.
   * @param input - the user message to deliver.
   */
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  /**
   * Queue a message for the running step and wake the driver.
   * @param input - the user message to deliver.
   */
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  /**
   * Queue a message for the running step without waking the driver.
   * @param input - the user message to deliver.
   */
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  /**
   * Run a maintenance job while the agent is idle.
   * @param job - the maintenance operation, receiving the phase abort signal.
   * @returns the maintenance result.
   */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity.
   * @param wakeAfterAbort - the {@link send} classification, captured before the
   *   inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /** Open one turn and run its steps until the inbox stops feeding it. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase: RunningPhase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds !== null && decision.messages.length === 0) break
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        const position: SinkPosition = { turn, step }
        this.sink.beginRun()
        this.sink.beginStep()
        this.sink.openStep(position)
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          const stepEnd = await this.runStep(decision.messages, position, signal)
          if (turnEnds === null) turnEnds = stepEnd
        } finally {
          // The sink may have rotated the step while the run was in flight, so
          // `position.step` — not the step this iteration opened — is the one
          // still open here, and it may still owe results the engine never
          // reported.
          this.sink.closeStep(position)
          this.releaseStep()
        }
        signal.throwIfAborted()
        if (turnEnds !== null && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds !== null && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error: { message: errorMessageOf(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // Every exit assigns a turn ending; the assertion records that.
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /**
   * Claim this step's messages and run them past the pre-step waterfall.
   * @param target - which inbox queue to claim from.
   * @param position - the turn/step being proposed.
   * @returns the step's decision.
   */
  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: claimed }),
    )
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    // Inject skill content for user-invoked skills. The dsh-tool-skill handler
    // that normally does this lives on the agent-preset context chain, which a
    // hosted agent's context does not descend from, so the gesture scan and the
    // injection are replicated here (identically to the four original drivers).
    const injected = await this.injectSkills(decision.messages, signal)
    signal.throwIfAborted()
    return injected !== decision.messages
      ? { kind: 'enter', messages: [...injected] }
      : { ...decision }
  }

  /**
   * Scan the step's user messages for `/name` skill gestures, load each matching
   * skill, and inject the rendered content into the batch.
   * @param messages - the step's message batch.
   * @param signal - cancellation (aborted loads are silently dropped).
   * @returns the original batch, or an extended one.
   */
  private async injectSkills(messages: readonly UserMessage[], signal: AbortSignal): Promise<readonly UserMessage[]> {
    const names = invokedSkillNames(messages)
    if (names.length === 0) return messages
    const skills = this.loopCtx.get('skills') as SkillsService | undefined
    if (skills === undefined) return messages
    const cwd = this.session.header.cwd
    const injections: UserMessage[] = []
    for (const name of names) {
      if (!isSkillName(name)) continue
      let skill: SkillDefinition | undefined
      try {
        skill = await skills.get(name, { signal, scope: this, ...cwd === undefined ? {} : { cwd } })
      } catch {
        continue // load failure → silently skip
      }
      if (skill === undefined || !skill.invocation.userInvocable) continue
      if (signal.aborted) return messages
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source: { kind: 'skill-invocation', name, form: 'instructions' },
      }))
    }
    return injections.length > 0 ? [...messages, ...injections] : messages
  }

  /**
   * Append the session's request-header snapshot, once per loop instance.
   *
   * Written by the driver rather than the sink because it describes the request
   * the ENGINE was asked to make, and only the driver knows when the first one
   * is about to go out.
   */
  protected assertRequestHeader(): void {
    if (this.requestHeaderLogged) return
    this.session.append('request/header', {
      header: {
        config: { provider: CLI_PROVIDER, model: this.modelLabel() },
      },
      reason: this.session.requestHeader() === undefined ? 'initial' : 'resume',
    } as never)
    this.requestHeaderLogged = true
  }

  /** Append a `tool/call` event for one call this step announced. */
  protected appendToolCall(callId: string, name: string, args: string): void {
    this.session.append('tool/call', { callId, name, arguments: args } as never)
  }

  /** The engine-scope teardown hook, installed in the constructor. */
  protected installTransportTeardown(): void {
    this.scope.ctx.effect(() => () => { this.disposeTransport() }, `${this.engine}.transport()`)
  }

  /** The transcript this step should send, as the sink's caller sees it. */
  protected history(): Message[] {
    return this.session.deriveMessages()
  }
}

/** A readable one-line message for any thrown value. */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
