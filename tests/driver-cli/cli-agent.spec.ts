/**
 * The shared CLI lifecycle: the turn/step machine every external-CLI engine runs.
 *
 * `driver-cli/cli-agent.ts` is the module the four original drivers' 450-line
 * copies were collapsed into, and it is where the subtle bugs live — a missing
 * `agent/error`, a step left open, an inbox claim that never wakes the driver.
 * Nothing in the suite exercised it as a MACHINE: the per-engine specs drive one
 * happy step each, so the phase transitions, the wake latches, maintenance,
 * cancellation and every error arm were untested.
 *
 * So this file drives it with a deliberately minimal fake engine — the smallest
 * possible subclass, whose `runStep` does what a test tells it to. That is the
 * point: the assertions here are about the base's contract, and an engine in the
 * way would make them about that engine.
 *
 * The fake engine reports through the same {@link SessionSink} a real driver
 * uses, so "the log" is real; only the wire is missing.
 *
 * @module tests/driver-cli/cli-agent
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type AgentOptions, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { CliHostedAgent, type CliAgentHost } from '../../src/driver-cli/cli-agent.ts'
import type { SinkPosition } from '../../src/driver-cli/session-sink.ts'
import { userMessage } from '../helpers/agent-harness.ts'

/** What the fake engine should do on its next step. */
type StepScript =
  | { kind: 'answer'; text: string }
  | { kind: 'throw'; message: string }
  | { kind: 'null' }
  | { kind: 'max-tokens' }
  | { kind: 'hang'; release: () => void }
  | { kind: 'two-segments'; first: string; second: string }

/**
 * The smallest legal engine: everything the base asks of a subclass, and nothing
 * else. `runStep` consults a script queue so a test can decide what each step
 * does, including "throw" and "hang".
 */
class FakeAgent extends CliHostedAgent {
  /** One entry per step this engine is asked to run. */
  readonly scripts: StepScript[] = []
  /** Every `runStep` call, in order, with the messages it was handed. */
  readonly steps: Array<{ messages: readonly UserMessage[]; position: SinkPosition }> = []
  /** Steps whose teardown hook ran. */
  readonly released: number[] = []
  /** Whether the transport teardown ran. */
  transportDisposed = false

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    host: CliAgentHost = { engine: 'zcode', model: undefined, env: {} },
  ) {
    super(loopCtx, id, options, session, host)
    this.installTransportTeardown()
  }

  /** Read the base's protected surface for assertions. */
  get phaseKind(): string {
    return (this as unknown as { phase: { kind: string } }).phase.kind
  }

  protected override async runStep(
    messages: readonly UserMessage[],
    position: SinkPosition,
    signal: AbortSignal,
  ): Promise<{ kind: 'completed' } | null> {
    this.steps.push({ messages, position })
    // Every real driver asserts the header before its first round trip; the
    // fake does the same so the header's once-only behaviour is exercised here.
    this.assertRequestHeader()
    const script = this.scripts.shift() ?? { kind: 'answer', text: 'default' }
    switch (script.kind) {
      case 'throw':
        throw new Error(script.message)
      case 'null':
        return null
      case 'max-tokens':
        this.sink.commitWholeMessage('partial', undefined, position)
        return { kind: 'max-tokens' }
      case 'hang':
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        throw signal.reason
      case 'two-segments':
        // A real engine can report a second assistant segment inside ONE round
        // trip (it ran a tool and answered again). The sink rotates the step for
        // it, which is what the subclass's `onStepRotated` hook is for.
        // The engine ran a tool before answering. Its result settles the step's
        // only tool, and the text that follows is therefore the NEXT step — that
        // is the rotation the sink performs and the base relays.
        this.sink.accept({ kind: 'tool-call', call: { id: 'c1', name: 'bash', arguments: '{}' } }, position)
        this.sink.accept({ kind: 'tool-result', result: { id: 'c1', text: 'ok', isError: false } }, position)
        this.sink.accept({ kind: 'text', text: script.second }, position)
        return { kind: 'completed' }
      default:
        this.sink.commitWholeMessage(script.text, undefined, position)
        return { kind: 'completed' }
    }
  }

  protected override releaseStep(): void {
    this.released.push(this.steps.length)
  }

  protected override disposeTransport(): void {
    this.transportDisposed = true
  }
}

/** A loop plugin that mounts the fake engine as the factory. */
function fakeLoopPlugin() {
  return {
    inject: ['agents', 'sessions', 'systemPrompt'],
    apply: (ctx: Context): void => {
      const factory = {
        create: async (options: never) => options,
      }
      void factory
      ctx.effect(() => ctx.agents.setFactory({
        create: async () => {
          throw new Error('the harness path is not used by these specs')
        },
        resume: async () => {
          throw new Error('the harness path is not used by these specs')
        },
      } as never), 'fake.setFactory()')
    },
  }
}

/** Boot the services the base reads, without mounting an engine factory. */
async function services(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** Build one fake agent on a fresh session. */
async function agentWith(
  scripts: StepScript[] = [],
  options: { cwd?: string | undefined; model?: string | undefined } = {},
): Promise<{ ctx: Context; agent: FakeAgent; session: Session }> {
  const ctx = await services()
  const session = ctx.sessions.prepare(SessionId(`fake-${Math.random().toString(36).slice(2)}`), {
    meta: { ...options.cwd === undefined ? {} : { cwd: options.cwd } },
  })
  ctx.sessions.enter(session)
  const agent = new FakeAgent(
    ctx,
    SessionId('fake'),
    { provider: 'external', model: options.model ?? 'fake-model' } as AgentOptions,
    session,
    { engine: 'zcode', model: options.model, env: {} },
  )
  agent.scripts.push(...scripts)
  return { ctx, agent, session }
}

/**
 * The session log's event types, in write order.
 *
 * Inbox mutations are durable events too (`agent/inbox/spliced` and friends),
 * so a transcript assertion has to ignore them: they record the queue moving,
 * not what the engine said.
 */
function types(session: Session): string[] {
  return session.snapshotEvents()
    .map(event => event.type)
    .filter(type => !type.startsWith('agent/inbox/'))
}

describe('the turn/step machine', () => {
  it('opens a turn, writes the user message, runs one step, and closes the turn', async () => {
    const { ctx, agent, session } = await agentWith([{ kind: 'answer', text: 'hi there' }])
    try {
      agent.followup(userMessage('hello'))
      await agent.whenIdle()

      const log = types(session)
      expect(log[0]).toBe('turn/start')
      expect(log).toContain('step/start')
      expect(log).toContain('user/message')
      expect(log).toContain('assistant/message')
      expect(log).toContain('step/end')
      expect(log.at(-1)).toBe('turn/end')

      // The turn ends `completed`, and the step saw the message it was given.
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ turn: 1, reason: { kind: 'completed' } })
      expect(agent.steps).toHaveLength(1)
      expect(agent.steps[0]!.position).toEqual({ turn: 1, step: 1 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs a second step in the same turn when a steer arrives mid-turn', async () => {
    // The first step queues a steer for itself; the loop must then run step 2
    // inside turn 1 rather than opening turn 2.
    const { ctx, agent, session } = await agentWith([
      { kind: 'answer', text: 'first' },
      { kind: 'answer', text: 'second' },
    ])
    try {
      const originalRunStep = agent['runStep'].bind(agent)
      vi.spyOn(agent as never, 'runStep' as never).mockImplementation((async (
        messages: readonly UserMessage[],
        position: SinkPosition,
        signal: AbortSignal,
      ) => {
        if (agent.steps.length === 0) agent.steer(userMessage('and this'))
        return originalRunStep(messages, position, signal)
      }) as never)

      agent.followup(userMessage('start'))
      await agent.whenIdle()

      expect(agent.steps.map(step => step.position)).toEqual([
        { turn: 1, step: 1 },
        { turn: 1, step: 2 },
      ])
      const turns = session.snapshotEvents().filter(event => event.type === 'turn/start')
      expect(turns).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('opens a second turn for a message queued for the next turn', async () => {
    const { ctx, agent, session } = await agentWith([
      { kind: 'answer', text: 'first' },
      { kind: 'answer', text: 'second' },
    ])
    try {
      const originalRunStep = agent['runStep'].bind(agent)
      vi.spyOn(agent as never, 'runStep' as never).mockImplementation((async (
        messages: readonly UserMessage[],
        position: SinkPosition,
        signal: AbortSignal,
      ) => {
        if (agent.steps.length === 0) agent.followup(userMessage('next turn'))
        return originalRunStep(messages, position, signal)
      }) as never)

      agent.followup(userMessage('start'))
      await agent.whenIdle()

      expect(agent.steps.map(step => step.position)).toEqual([
        { turn: 1, step: 1 },
        { turn: 2, step: 1 },
      ])
      const turns = session.snapshotEvents().filter(event => event.type === 'turn/start')
      expect(turns.map(event => event.data)).toEqual([{ turn: 1 }, { turn: 2 }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('treats an inject as queued-but-not-waking', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'answer', text: 'ok' }])
    try {
      agent.inject(userMessage('do not wake'))
      // Nothing was started: an inject only queues.
      expect(agent.status).toBe('idle')
      expect(agent.steps).toHaveLength(0)
      await agent.whenIdle()
      expect(agent.steps).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a rejected pre-step as a blocked turn and runs no step', async () => {
    const { ctx, agent, session } = await agentWith()
    try {
      // A waterfall listener that refuses the step is the harness's own veto
      // (a commit veto, an approval gate). The machine must not invent a step.
      ctx.on('agent/pre-step', () => ({ kind: 'reject' } as PreStepDecision))
      agent.followup(userMessage('blocked'))
      await agent.whenIdle()

      expect(agent.steps).toHaveLength(0)
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'blocked' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the turn without a step when the pre-step yields no messages', async () => {
    // The harness's own "nothing to do" arm: the inbox claim came back empty,
    // which happens when a queued message was withdrawn before the step opened.
    const { ctx, agent, session } = await agentWith()
    try {
      ctx.on('agent/pre-step', () => ({ kind: 'enter', messages: [] } as PreStepDecision))
      agent.followup(userMessage('vanishes'))
      await agent.whenIdle()

      expect(agent.steps).toHaveLength(0)
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'completed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a max-tokens verdict from the first step of the turn', async () => {
    const { ctx, agent, session } = await agentWith([{ kind: 'max-tokens' }])
    try {
      agent.followup(userMessage('be long'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'max-tokens' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('turns a thrown step into an agent/error and an error turn ending', async () => {
    const { ctx, agent, session } = await agentWith([{ kind: 'throw', message: 'the engine died' }])
    const errors: unknown[] = []
    try {
      ctx.on('agent/error', event => { errors.push(event) })
      agent.followup(userMessage('go'))
      await agent.whenIdle()

      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ error: { message: 'the engine died' } })
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: 'the engine died' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a cancellation as an aborted turn, not as an error', async () => {
    const { ctx, agent, session } = await agentWith([{ kind: 'hang', release: () => {} }])
    try {
      agent.followup(userMessage('run forever'))
      // Let the step start, then cancel it.
      await vi.waitFor(() => { expect(agent.steps).toHaveLength(1) })
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()

      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'aborted' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the inbox when a cancel asks to', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'hang', release: () => {} }])
    try {
      agent.followup(userMessage('run forever'))
      await vi.waitFor(() => { expect(agent.steps).toHaveLength(1) })
      // Queued for the NEXT step, so it is still pending when the cancel lands.
      agent.inject(userMessage('stay queued'))
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await agent.whenIdle()
      expect(agent.inbox.hasPending).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the inbox when a cancel does not ask to keep it', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'hang', release: () => {} }])
    try {
      agent.followup(userMessage('run forever'))
      await vi.waitFor(() => { expect(agent.steps).toHaveLength(1) })
      agent.inject(userMessage('dropped with the cancel'))
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect(agent.inbox.hasPending).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports running while a step is in flight and idle afterwards', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'hang', release: () => {} }, { kind: 'answer', text: 'ok' }])
    const statuses: string[] = []
    try {
      ctx.on('agent/status', event => { statuses.push(event.status) })
      agent.followup(userMessage('go'))
      await vi.waitFor(() => { expect(agent.steps).toHaveLength(1) })
      expect(agent.status).toBe('running')
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect(agent.status).toBe('idle')
      // Both transitions were published, and never the same one twice in a row.
      expect(statuses).toEqual(['running', 'idle'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs a maintenance job while idle, and refuses one while busy', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'hang', release: () => {} }])
    try {
      await expect(agent.runMaintenance(async () => 'done')).resolves.toBe('done')

      agent.followup(userMessage('go'))
      await vi.waitFor(() => { expect(agent.steps).toHaveLength(1) })
      // Thrown synchronously: a busy agent must refuse before the job is even
      // scheduled, not return a promise that rejects later.
      expect(() => agent.runMaintenance(async () => 'nope')).toThrow(/already has active work/)
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('wakes the driver after maintenance when a wake was latched during it', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'answer', text: 'after maintenance' }])
    try {
      const maintenance = agent.runMaintenance(async () => {
        // A followup during maintenance cannot start the driver, so it latches.
        agent.followup(userMessage('queued during maintenance'))
        return 'done'
      })
      await expect(maintenance).resolves.toBe('done')
      await agent.whenIdle()
      // The latched wake ran the queued message once maintenance released the phase.
      expect(agent.steps).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not start a turn for an empty wake', async () => {
    // `whenIdle` on an agent that never had work must be a no-op, not a turn.
    const { ctx, agent, session } = await agentWith()
    try {
      await agent.whenIdle()
      expect(agent.steps).toHaveLength(0)
      expect(types(session)).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the request header and provenance', () => {
  it('logs the request header once, naming the hosted route', async () => {
    const { ctx, agent, session } = await agentWith([
      { kind: 'answer', text: 'one' },
      { kind: 'answer', text: 'two' },
    ], { model: 'fake-model' })
    try {
      agent.followup(userMessage('first'))
      await agent.whenIdle()
      agent.followup(userMessage('second'))
      await agent.whenIdle()

      const headers = session.snapshotEvents().filter(event => event.type === 'request/header')
      expect(headers).toHaveLength(1)
      expect(headers[0]!.data).toMatchObject({
        header: { config: { provider: 'external', model: 'fake-model' } },
        reason: 'initial',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names the deployment’s model when the engine pinned none', async () => {
    // `model: undefined` in the host facts must resolve to the shared
    // placeholder rather than to a composite string naming an unserved model.
    const ctx = await services()
    try {
      const session = ctx.sessions.prepare(SessionId('no-model'), { meta: { cwd: '/work' } })
      ctx.sessions.enter(session)
      const agent = new FakeAgent(ctx, SessionId('no-model'), { provider: 'external' } as AgentOptions, session)
      agent.scripts.push({ kind: 'answer', text: 'ok' })
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const header = session.requestHeader()
      expect(header?.config).toMatchObject({ provider: 'external' })
      expect(header?.config?.model).toBe('default')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the transport teardown', () => {
  it('disposes the engine transport when the agent scope unwinds', async () => {
    const { ctx, agent } = await agentWith()
    try {
      expect(agent.transportDisposed).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
    expect(agent.transportDisposed).toBe(true)
  })

  it('releases the step on success, failure and cancellation alike', async () => {
    const { ctx, agent } = await agentWith([
      { kind: 'answer', text: 'ok' },
      { kind: 'throw', message: 'boom' },
      { kind: 'hang', release: () => {} },
    ])
    try {
      agent.followup(userMessage('one'))
      await agent.whenIdle()
      expect(agent.released).toEqual([1])

      agent.followup(userMessage('two'))
      await agent.whenIdle()
      expect(agent.released).toEqual([1, 2])

      agent.followup(userMessage('three'))
      await vi.waitFor(() => { expect(agent.steps).toHaveLength(3) })
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect(agent.released).toEqual([1, 2, 3])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the subclass surface', () => {
  it('hands the subclass the environment, the transcript and the tool-call writer', async () => {
    // `env`, `history()` and `appendToolCall` are the three things a driver's
    // `runStep` reaches for that are not part of the turn machine. They are
    // protected, so they are read through a subclass here rather than by
    // reaching into the object.
    const ctx = await services()
    try {
      const session = ctx.sessions.prepare(SessionId('surface'), { meta: { cwd: '/work' } })
      ctx.sessions.enter(session)
      const agent = new FakeAgent(ctx, SessionId('surface'), { provider: 'external' } as AgentOptions, session, {
        engine: 'zcode',
        model: undefined,
        env: { PROBE: 'from-host-facts' },
      })
      expect(agent['env']).toEqual({ PROBE: 'from-host-facts' })
      expect(agent['engine']).toBe('zcode')
      // The transcript is the session's own derived view, not a private copy.
      expect(agent['history']()).toEqual([])
      agent['appendToolCall']('call_1', 'bash', '{"command":"echo hi"}')
      const call = session.snapshotEvents().find(event => event.type === 'tool/call')
      expect(call?.data).toMatchObject({ callId: 'call_1', name: 'bash' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('defaults the step-rotation and release hooks to no-ops', async () => {
    // A driver that holds a persistent child overrides none of these. The BASE
    // implementations must therefore be harmless rather than "not implemented"
    // — which is why they are called on the prototype, not on the fake (whose
    // overrides would hide the very thing under test).
    const { ctx, agent } = await agentWith([{ kind: 'answer', text: 'ok' }])
    try {
      const base = CliHostedAgent.prototype as unknown as {
        onStepRotated: (step: number) => void
        releaseStep: () => void
        disposeTransport: () => void
      }
      expect(() => base.onStepRotated.call(agent, 2)).not.toThrow()
      expect(() => base.releaseStep.call(agent)).not.toThrow()
      expect(() => base.disposeTransport.call(agent)).not.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rotates the step through the sink and notifies the subclass', async () => {
    // The sink can rotate mid-run (an engine that reports a second step's
    // frames inside one round trip). The base must relay that to the subclass,
    // because a per-step driver has to reset its own state there.
    // No pre-queued script: the two-segment run IS this test's only step.
    const { ctx, agent } = await agentWith()
    const rotated: number[] = []
    try {
      vi.spyOn(agent as never, 'onStepRotated' as never).mockImplementation(((step: number) => {
        rotated.push(step)
      }) as never)
      agent.scripts.push({ kind: 'two-segments', first: 'one', second: 'two' })
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      // The second segment rotated the sink onto step 2, and the base relayed it.
      expect(rotated).toEqual([2])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a non-Error throw as a string message', async () => {
    // `errorMessageOf` has to handle a thrown string, because a driver that
    // rejects with a plain value would otherwise log `[object Object]`.
    const { ctx, agent, session } = await agentWith()
    try {
      agent.scripts.push({ kind: 'throw', message: '' })
      vi.spyOn(agent as never, 'runStep' as never).mockImplementation((async () => {
        throw 'a plain string'
      }) as never)
      agent.followup(userMessage('go'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'error', error: { message: 'a plain string' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('skill injection', () => {
  /** A skills service returning whatever the test scripted. */
  function skillsService(script: {
    get?: (name: string) => unknown
  }): { get: ReturnType<typeof vi.fn> } {
    return {
      get: vi.fn(async (name: string) => (script.get === undefined ? undefined : script.get(name))),
    }
  }

  it('injects a user-invocable skill as an extra message in the step', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'answer', text: 'ok' }], { cwd: '/work' })
    try {
      ctx.provide('skills', skillsService({
        get: () => ({
          name: 'review-pr',
          invocation: { modelInvocable: true, userInvocable: true },
          content: '# Review it',
          source: 'custom',
          provider: 'zcode',
          description: 'review',
        }),
      }) as never)
      agent.followup(userMessage('/review-pr please'))
      await agent.whenIdle()

      // The engine saw the user's message AND the rendered skill content.
      const delivered = agent.steps[0]!.messages
      expect(delivered.length).toBe(2)
      expect(JSON.stringify(delivered[1])).toContain('# Review it')
      // The session's own cwd travels with the load request.
      expect((ctx.get('skills') as { get: ReturnType<typeof vi.fn> }).get.mock.calls[0]![1])
        .toMatchObject({ cwd: '/work' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips a skill that is unknown, not user-invocable, or fails to load', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'answer', text: 'ok' }])
    try {
      ctx.provide('skills', skillsService({
        get: (name) => {
          if (name === 'throws') throw new Error('load failed')
          if (name === 'model-only') return { name, invocation: { modelInvocable: true, userInvocable: false } }
          return undefined
        },
      }) as never)
      agent.followup(userMessage('/missing /throws /model-only'))
      await agent.whenIdle()
      // Every gesture was skipped, so the engine got exactly the user's message.
      expect(agent.steps[0]!.messages).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes the batch through untouched when the profile has no skills service', async () => {
    // A minimal profile legitimately has none; the step must still run.
    const { ctx, agent } = await agentWith([{ kind: 'answer', text: 'ok' }])
    try {
      agent.followup(userMessage('/review-pr'))
      await agent.whenIdle()
      expect(agent.steps[0]!.messages).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops an injection when the load resolves after a cancellation', async () => {
    const { ctx, agent } = await agentWith([{ kind: 'answer', text: 'ok' }])
    try {
      const controller = new AbortController()
      controller.abort()
      ctx.provide('skills', skillsService({
        // Resolve only after the signal is already aborted: the guard inside
        // the loop is what stops the injection from landing on a dead step.
        get: () => ({
          name: 'review-pr',
          invocation: { modelInvocable: true, userInvocable: true },
          content: '# late',
        }),
      }) as never)
      // Drive `injectSkills` directly: the turn machine would refuse to start
      // an aborted step before reaching it.
      const injected = await (agent as unknown as {
        injectSkills: (m: readonly UserMessage[], s: AbortSignal) => Promise<readonly UserMessage[]>
      }).injectSkills([userMessage('/review-pr')], controller.signal)
      expect(injected).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the wake latch across a cancellation', () => {
  it('wakes again for a message that arrived after an abort', async () => {
    // `send` classifies a wakeup during an aborted phase as "next turn", and
    // latches it: the running kick cannot accept it, so its `finally` has to
    // start the next driver. Without that, a followup sent right after a cancel
    // would sit in the inbox forever.
    const { ctx, agent } = await agentWith([
      { kind: 'hang', release: () => {} },
      { kind: 'answer', text: 'second run' },
    ])
    try {
      agent.followup(userMessage('run forever'))
      await vi.waitFor(() => { expect(agent.steps).toHaveLength(1) })
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      agent.followup(userMessage('after the cancel'))
      await agent.whenIdle()

      // The latched wake ran a second driver for the queued message.
      await vi.waitFor(() => { expect(agent.steps.length).toBeGreaterThanOrEqual(2) })
      expect(agent.steps.at(-1)!.messages).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends the turn when a continued step claims no messages', async () => {
    // A steer keeps the turn open for another step; if that step's pre-step
    // yields nothing (a withdrawn message), the turn must end rather than spin.
    const { ctx, agent, session } = await agentWith([
      { kind: 'answer', text: 'first' },
      { kind: 'answer', text: 'never' },
    ])
    try {
      let steps = 0
      const originalRunStep = agent['runStep'].bind(agent)
      vi.spyOn(agent as never, 'runStep' as never).mockImplementation((async (
        messages: readonly UserMessage[],
        position: SinkPosition,
        signal: AbortSignal,
      ) => {
        steps += 1
        if (steps === 1) agent.steer(userMessage('keep the turn open'))
        return originalRunStep(messages, position, signal)
      }) as never)
      // The second proposal comes back empty.
      ctx.on('agent/pre-step', () => ({ kind: 'enter', messages: [] } as PreStepDecision))

      agent.followup(userMessage('go'))
      await agent.whenIdle()

      const ends = session.snapshotEvents().filter(event => event.type === 'turn/end')
      expect(ends).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('defensive arms', () => {
  it('reports a session write failure at its live boundary', async () => {
    // `session.append` can throw (a closed or refused write handle). The base
    // must report that as an agent/error rather than losing it inside the
    // driver's containment.
    const { ctx, agent, session } = await agentWith([{ kind: 'answer', text: 'ok' }])
    try {
      const original = session.append.bind(session)
      vi.spyOn(session, 'append').mockImplementation(((type: string, ...rest: unknown[]) => {
        if (type === 'turn/start') throw new Error('the log refused the write')
        return (original as never)(type, ...rest)
      }) as never)
      const errors: unknown[] = []
      ctx.on('agent/error', event => { errors.push(event) })
      agent.followup(userMessage('go'))
      await agent.whenIdle()
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ error: { message: 'the log refused the write' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a failure to write the turn ending', async () => {
    // The turn-end write is in a `finally`: if IT fails, the failure has to be
    // reported rather than thrown past the driver boundary.
    const { ctx, agent, session } = await agentWith([{ kind: 'answer', text: 'ok' }])
    try {
      const original = session.append.bind(session)
      vi.spyOn(session, 'append').mockImplementation(((type: string, ...rest: unknown[]) => {
        if (type === 'turn/end') throw new Error('the log refused the ending')
        return (original as never)(type, ...rest)
      }) as never)
      const errors: unknown[] = []
      ctx.on('agent/error', event => { errors.push(event) })
      agent.followup(userMessage('go'))
      await agent.whenIdle()
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ error: { message: 'the log refused the ending' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('logs a resume header when the session already carries one', async () => {
    // A resumed session has a request header from the previous run; the second
    // driver must record `resume`, not `initial`, because that is what tells a
    // reader the engine was re-entered rather than first contacted.
    const { ctx, agent, session } = await agentWith([
      { kind: 'answer', text: 'one' },
      { kind: 'answer', text: 'two' },
    ], { model: 'fake-model' })
    try {
      agent.followup(userMessage('first'))
      await agent.whenIdle()

      // A second agent on the SAME session (what a resume builds).
      const resumed = new FakeAgent(ctx, SessionId('fake'), { provider: 'external', model: 'fake-model' } as AgentOptions, session, {
        engine: 'zcode',
        model: 'fake-model',
        env: {},
      })
      resumed.scripts.push({ kind: 'answer', text: 'two' })
      resumed.followup(userMessage('second'))
      await resumed.whenIdle()

      const headers = session.snapshotEvents().filter(event => event.type === 'request/header')
      expect(headers.map(event => event.data)).toEqual([
        { header: { config: { provider: 'external', model: 'fake-model' } }, reason: 'initial' },
        { header: { config: { provider: 'external', model: 'fake-model' } }, reason: 'resume' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('injects a skill for a session that has no working directory', async () => {
    // The `cwd` is optional metadata; a skill load must still be attempted
    // without one rather than skipping injection entirely.
    const { ctx, agent } = await agentWith([{ kind: 'answer', text: 'ok' }], { cwd: undefined })
    try {
      const get = vi.fn(async () => ({
        name: 'review-pr',
        invocation: { modelInvocable: true, userInvocable: true },
        content: '# Review',
        source: 'custom',
        provider: 'zcode',
        description: 'review',
      }))
      ctx.provide('skills', { get } as never)
      agent.followup(userMessage('/review-pr'))
      await agent.whenIdle()
      expect(get).toHaveBeenCalledTimes(1)
      // No `cwd` key in the options it was asked with.
      expect(get.mock.calls[0]![1]).not.toHaveProperty('cwd')
      expect(agent.steps[0]!.messages).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ends a turn whose continuation claims nothing, without a second step', async () => {
    // The `turnEnds !== null && messages.length === 0` break: a turn that has
    // already been given its verdict must not keep proposing steps.
    const { ctx, agent, session } = await agentWith([
      { kind: 'max-tokens' },
      { kind: 'answer', text: 'never reached' },
    ])
    try {
      let steps = 0
      const original = agent['runStep'].bind(agent)
      vi.spyOn(agent as never, 'runStep' as never).mockImplementation((async (
        messages: readonly UserMessage[],
        position: SinkPosition,
        signal: AbortSignal,
      ) => {
        steps += 1
        if (steps === 1) agent.steer(userMessage('more'))
        return original(messages, position, signal)
      }) as never)
      // Every proposal after the first comes back empty.
      let calls = 0
      ctx.on('agent/pre-step', () => {
        calls += 1
        return (calls === 1
          ? { kind: 'enter', messages: [userMessage('go')] }
          : { kind: 'enter', messages: [] }) as PreStepDecision
      })

      agent.followup(userMessage('go'))
      await agent.whenIdle()

      expect(agent.steps).toHaveLength(1)
      const ends = session.snapshotEvents().filter(event => event.type === 'turn/end')
      expect(ends).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
