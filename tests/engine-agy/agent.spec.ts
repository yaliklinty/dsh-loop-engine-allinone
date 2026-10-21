/**
 * The Antigravity driver end to end: a real session, a scripted `agy` child.
 *
 * Antigravity is the engine whose protocol was rewritten after a signed-in host
 * became available (captured by `scripts/probe/probe.mjs` and recorded in the fork's probe report, §3), so its driver has more
 * engine-specific decisions than the other three: the prompt travels on STDIN as
 * one NDJSON document (not in argv), the optional `--print` argument has to be
 * attached empty so it cannot swallow the next flag, and the permission switch is
 * all-or-nothing and derived from the session's sandbox knob rather than from a
 * mode word.
 *
 * Each of those is pinned here. The child is faked at the spawn capability, so
 * the assertions are about the driver's decisions; the frame vocabulary itself is
 * pinned against real captures in `tests/engine-agy/frames.spec.ts`.
 *
 * @module tests/engine-agy/agent
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { AgyLoop } from '../../src/engine-agy/loop.ts'
import { AgyAgent, AGY_ENGINE, type ResolvedAgyConfig } from '../../src/engine-agy/agent.ts'
import { loopPluginFor, mountHarness, userMessage } from '../helpers/agent-harness.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'
import { DSH_ENDPOINT, provideDshEndpoint } from '../helpers/dsh-model-endpoint.ts'

/** One spawn the driver made, with the stdin it was given. */
interface Spawned {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  /** Every payload written to stdin, in order. */
  readonly written: string[]
  /** Whether stdin was closed after the payload (a left-open pipe hangs a step). */
  readonly closed: boolean
}

/**
 * A fake spawn capability that prints the given documents, one JSON per line.
 *
 * `stdin` is recorded rather than ignored: for this engine the prompt travels
 * there, so a driver that forgot to write it would otherwise look identical to
 * one that did.
 */
function fakeSpawn(documents: readonly unknown[] = [], options: { exitCode?: number | null } = {}) {
  const spawned: Spawned[] = []
  const text = documents.map(document => JSON.stringify(document)).join('\n')
  const spawn = vi.fn((request: { argv: readonly string[]; cwd: string; env: Record<string, string> }) => {
    const written: string[] = []
    let closed = false
    const record: Spawned = { argv: request.argv, cwd: request.cwd, env: request.env, written, get closed() { return closed } }
    spawned.push(record)
    const stream = (payload: string) => (async function* () {
      if (payload !== '') yield Buffer.from(`${payload}\n`, 'utf8')
    })()
    return {
      stdin: {
        write: (chunk: string) => { written.push(chunk) },
        end: () => { closed = true },
      },
      stdout: stream(text),
      stderr: stream(''),
      done: Promise.resolve({ exitCode: options.exitCode === undefined ? 0 : options.exitCode }),
      terminate: vi.fn(),
    }
  })
  return { spawn: spawn as never, spawned }
}

/** A resolved config with the knobs a deployment may pin. */
function config(overrides: Partial<ResolvedAgyConfig> = {}): ResolvedAgyConfig {
  return {
    bin: 'agy',
    env: {},
    model: undefined,
    mode: undefined,
    effort: undefined,
    sandbox: undefined,
    dangerouslySkipPermissions: undefined,
    ...overrides,
  }
}

/** Boot the services, with a session at the given cwd. */
async function harness(options: { cwd?: string | undefined } = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.prepare(SessionId(`agy-${Math.random().toString(36).slice(2)}`), {
    meta: { ...options.cwd === undefined ? {} : { cwd: options.cwd } },
  })
  ctx.sessions.enter(session)
  return { ctx, session }
}

/** Build one agent on a prepared session. */
async function agentWith(
  documents: readonly unknown[] = [],
  options: { cwd?: string | undefined; config?: Partial<ResolvedAgyConfig>; exitCode?: number | null } = {},
): Promise<{ ctx: Context; session: Session; agent: AgyAgent; spawned: Spawned[] }> {
  const { ctx, session } = await harness(options)
  const { spawn, spawned } = fakeSpawn(documents, { exitCode: options.exitCode })
  const agent = new AgyAgent(
    ctx,
    session.header.id,
    { provider: 'external' } as never,
    session,
    config(options.config),
    spawn,
  )
  return { ctx, session, agent, spawned }
}

/** The captured text-only turn, in the shape the live CLI emits. */
const TEXT_TURN: unknown[] = [
  { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'PONG' } },
  { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 5, output_tokens: 2 } } },
  { event: 'result', result: { status: 'SUCCESS', response: 'PONG', usage: { input_tokens: 5, output_tokens: 2 } } },
]

describe('one completed step', () => {
  it('writes the prompt to stdin as one NDJSON user message and closes the pipe', async () => {
    // The prompt does NOT travel in argv for this engine. `--print=` is attached
    // empty on purpose: left bare, `--print` swallows the next flag as its value.
    const { ctx, session, agent, spawned } = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      const call = spawned[0]!
      expect(call.argv[0]).toBe('agy')
      expect(call.argv).toContain('--input-format')
      expect(call.argv).toContain('stream-json')
      // The pinned-empty optional argument, verbatim.
      expect(call.argv).toContain('--print=')
      expect(call.cwd).toBe('/work')

      // Exactly one document on stdin, `event`-tagged (the CLI's discriminator),
      // and the pipe closed so the child does not wait for more.
      expect(call.written).toHaveLength(1)
      const document = JSON.parse(call.written[0]!) as {
        event: string
        message: { role: string; content: Array<{ type: string; text: string }> }
      }
      expect(document.event).toBe('user')
      expect(document.message.role).toBe('user')
      expect(document.message.content[0]!.text).toContain('say PONG')
      expect(call.closed).toBe(true)

      const message = session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(message?.data).toMatchObject({
        message: { role: 'assistant', source: { kind: 'model', provider: 'external' } },
      })
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'completed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes the pinned mode, model and effort, and omits each when unpinned', async () => {
    const pinned = await agentWith(TEXT_TURN, {
      cwd: '/work',
      config: { mode: 'plan', model: 'gemini-3-pro', effort: 'high' },
    })
    try {
      pinned.agent.followup(userMessage('hi'))
      await pinned.agent.whenIdle()
      const argv = pinned.spawned[0]!.argv
      expect(argv[argv.indexOf('--mode') + 1]).toBe('plan')
      expect(argv[argv.indexOf('--model') + 1]).toBe('gemini-3-pro')
      expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
    } finally {
      await pinned.ctx.fiber.dispose()
    }

    const bare = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      bare.agent.followup(userMessage('hi'))
      await bare.agent.whenIdle()
      const argv = bare.spawned[0]!.argv
      // No `--mode`: the set of modes an account accepts is not knowable ahead of
      // time, so omitting the flag lets the CLI use its own default instead of
      // warning on every step.
      expect(argv).not.toContain('--mode')
      expect(argv).not.toContain('--model')
      expect(argv).not.toContain('--effort')
    } finally {
      await bare.ctx.fiber.dispose()
    }
  })

  it('derives the permission switch from the session’s sandbox knob', async () => {
    // One all-or-nothing switch, and it is the only thing that lets a headless
    // run execute a tool at all.
    const denied = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      denied.agent.followup(userMessage('hi'))
      await denied.agent.whenIdle()
      expect(denied.spawned[0]!.argv).not.toContain('--dangerously-skip-permissions')
      // A session that is not at full access asks the CLI to restrict itself.
      expect(denied.spawned[0]!.argv).toContain('--sandbox')
    } finally {
      await denied.ctx.fiber.dispose()
    }

    const allowed = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      allowed.agent.session.append('sandbox/mode', { mode: 'danger-full-access' } as never)
      allowed.agent.followup(userMessage('hi'))
      await allowed.agent.whenIdle()
      expect(allowed.spawned[0]!.argv).toContain('--dangerously-skip-permissions')
      expect(allowed.spawned[0]!.argv).not.toContain('--sandbox')
    } finally {
      await allowed.ctx.fiber.dispose()
    }
  })

  it('lets a pinned sandbox/auto-approve flag override the session', async () => {
    // A deployment that pinned the switch does not want the session's knob to
    // flip it under them.
    const { ctx, agent, spawned } = await agentWith(TEXT_TURN, {
      cwd: '/work',
      config: { sandbox: true, dangerouslySkipPermissions: true },
    })
    try {
      // The session says full access, but the pin says `--sandbox`.
      agent.session.append('sandbox/mode', { mode: 'danger-full-access' } as never)
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned[0]!.argv).toContain('--sandbox')
      expect(spawned[0]!.argv).toContain('--dangerously-skip-permissions')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a failed result the engine itself declared', async () => {
    const { ctx, session, agent } = await agentWith(
      [{ event: 'result', result: { status: 'ERROR', error: 'quota exhausted' } }],
      { cwd: '/work' },
    )
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'error' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails a child that printed nothing parseable, quoting the last line', async () => {
    const { ctx, session } = await harness({ cwd: '/work' })
    try {
      const spawn = vi.fn(() => {
        const stream = (payload: string) => (async function* () {
          if (payload !== '') yield Buffer.from(`${payload}\n`, 'utf8')
        })()
        return {
          stdin: { write: vi.fn(), end: vi.fn() },
          stdout: stream('agy: not signed in'),
          stderr: stream(''),
          done: Promise.resolve({ exitCode: 0 }),
          terminate: vi.fn(),
        }
      })
      const agent = new AgyAgent(
        ctx,
        session.header.id,
        { provider: 'external' } as never,
        session,
        config(),
        spawn as never,
      )
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: {
          kind: 'error',
          error: { message: expect.stringMatching(/agy produced no stream-json on its protocol channel; last line: agy: not signed in/) },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the last-line detail when the child printed nothing at all', async () => {
    const { ctx, session } = await harness({ cwd: '/work' })
    try {
      const spawn = vi.fn(() => ({
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        done: Promise.resolve({ exitCode: 0 }),
        terminate: vi.fn(),
      }))
      const agent = new AgyAgent(
        ctx,
        session.header.id,
        { provider: 'external' } as never,
        session,
        config(),
        spawn as never,
      )
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      const message = (end?.data as { reason: { error: { message: string } } }).reason.error.message
      expect(message).toContain('produced no stream-json')
      expect(message).not.toContain('last line')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('what the driver refuses rather than degrades', () => {
  it('refuses a step that carries images', async () => {
    const { ctx, session, agent, spawned } = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      agent.followup(createUserMessage({
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { kind: 'attachment', attachmentId: 'a1' } } as never,
        ],
        source: { kind: 'user' },
      }) as UserMessage)
      await agent.whenIdle()
      expect(spawned).toHaveLength(0)
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: expect.stringMatching(/cannot receive images/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a step with no working directory', async () => {
    const { ctx, session, agent, spawned } = await agentWith(TEXT_TURN, { cwd: undefined })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned).toHaveLength(0)
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: expect.stringMatching(/no working directory/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a step whose transcript yields no prompt', async () => {
    const { ctx, agent } = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      vi.spyOn(agent as never, 'history' as never).mockReturnValue([] as never)
      await expect(
        (agent as unknown as {
          runStep: (m: readonly UserMessage[], p: { turn: number; step: number }, s: AbortSignal) => Promise<unknown>
        }).runStep([], { turn: 1, step: 1 }, new AbortController().signal),
      ).rejects.toThrow(/cannot derive a prompt from an empty session log/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a model picked from ANOTHER engine’s catalog', async () => {
    // The model menu is host-global, so a seat naming another engine's model
    // while the session runs on agy is reachable. Dropping the pick would leave
    // the seat naming a model that is not in force, so the step is refused.
    const { ctx, session, agent, spawned } = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      // The host's own fold, so the selection is read the way the host reads it.
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      // `undefined` members are not JSON-serializable, so the durable event
      // carries only the two fields a selection always has.
      session.append('model/selection', { provider: 'kimi', model: 'kimi-k2' } as never)
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned).toHaveLength(0)
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: expect.stringMatching(/belongs to another hosted engine/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the loop module', () => {
  it('exposes its ctx key and builds its own agent type', async () => {
    const plugin = loopPluginFor(AgyLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, { model: 'gemini-3-pro' }, 'stub')
    try {
      expect(ctx.get('agentLoopAgy')).toBeDefined()
      const { agent } = await ctx.agents.create({ sessionId: SessionId('built'), meta: { cwd: '/work' } })
      expect(agent.constructor.name).toBe('AgyAgent')
      expect(AGY_ENGINE).toBe('agy')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves an empty bin to the CLI’s own resolution', async () => {
    // `bin: ''` means "I did not decide"; the resolver then looks in the
    // Antigravity install directory and finally PATH.
    const plugin = loopPluginFor(AgyLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, { bin: '' }, 'stub')
    try {
      const loop = ctx.get('agentLoopAgy') as { config: { bin?: string } } | undefined
      expect(loop?.config.bin).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the session it was asked to build when there is no subprocess service', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    try {
      expect(() => new AgyLoop(ctx, {})).toThrow(/the agy engine needs the dsh subprocess service/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the unpinned executable', () => {
  it('passes the bare name when the deployment pinned none', async () => {
    // `config.bin ?? 'agy'`: the resolved config already fell back, so an
    // unpinned deployment must reach the child as the PATH name rather than as
    // `undefined`.
    const { ctx, agent, spawned } = await agentWith(TEXT_TURN, { cwd: '/work', config: { bin: undefined } })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned[0]!.argv[0]).toBe('agy')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('a dsh model handed to Antigravity', () => {
  it('rides the CLI\'s own LLM gateway environment, and names the model in argv', async () => {
    const { ctx, session, agent, spawned } = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      provideDshEndpoint(ctx, { api: 'openai-completions' })
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      // Measured: these three variables make the CLI fetch `{url}/models` and POST
      // `{url}/chat/completions` with the key as Bearer.
      expect(spawned[0]!.env).toMatchObject({
        AGY_LLM_GATEWAY_URL: DSH_ENDPOINT.baseURL,
        AGY_LLM_GATEWAY_API_KEY: DSH_ENDPOINT.apiKey,
        AGY_LLM_GATEWAY_WIRE_PROTOCOL: 'openai',
      })
      // The model is still named per run, in the CLI's own vocabulary.
      expect(spawned[0]!.argv).toEqual(expect.arrayContaining(['--model', DSH_ENDPOINT.model]))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a dsh model whose endpoint dsh cannot disclose, before spawning', async () => {
    const { ctx, session, agent, spawned } = await agentWith(TEXT_TURN, { cwd: '/work' })
    try {
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      session.append('model/selection', { provider: 'minimax', model: 'MiniMax-M3.1-Flash' })
      agent.followup(userMessage('hi'))
      await agent.whenIdle()

      expect(spawned).toHaveLength(0)
      expect(session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: 'UNSERVABLE_MODEL' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
