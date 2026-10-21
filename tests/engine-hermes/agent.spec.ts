/**
 * The Hermes Agent driver end to end: a real session, a faked `hermes -z` child.
 *
 * Hermes is a plain-text engine (`capabilities.protocol: 'text'`): `-z PROMPT`
 * prints the finished answer and exits, with no frames, no streaming and no tool
 * events. That makes it the clearest place to pin what a text engine owes the
 * transcript — the whole answer as ONE assistant message, shaped like a
 * streaming engine's so a later replay cannot tell them apart — and what it must
 * refuse rather than degrade.
 *
 * The child is faked at the spawn capability. Nothing here claims `hermes`
 * really answered; that is the smoke script and the live runs recorded in
 * the fork's probe report.
 *
 * @module tests/engine-hermes/agent
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { HermesLoop } from '../../src/engine-hermes/loop.ts'
import { HermesAgent, HERMES_ENGINE, type ResolvedHermesConfig } from '../../src/engine-hermes/agent.ts'
import { loopPluginFor, mountHarness, userMessage } from '../helpers/agent-harness.ts'
import { DSH_ENDPOINT, provideDshEndpoint } from '../helpers/dsh-model-endpoint.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'

/** One spawn the driver made. */
interface Spawned {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
}

/**
 * A fake spawn capability: print `stdout`, optionally complain on stderr, exit
 * with `exitCode`. Hermes takes its prompt in argv, so no stdin is requested.
 */
function fakeSpawn(options: { stdout?: string; stderr?: string; exitCode?: number | null } = {}) {
  const spawned: Spawned[] = []
  const spawn = vi.fn((request: { argv: readonly string[]; cwd: string; env: Record<string, string> }) => {
    spawned.push({ argv: request.argv, cwd: request.cwd, env: request.env })
    const stream = (text: string) => (async function* () {
      if (text !== '') yield Buffer.from(text, 'utf8')
    })()
    return {
      stdin: undefined,
      stdout: stream(options.stdout ?? ''),
      stderr: stream(options.stderr ?? ''),
      done: Promise.resolve({ exitCode: options.exitCode === undefined ? 0 : options.exitCode }),
      terminate: vi.fn(),
    }
  })
  return { spawn: spawn as never, spawned }
}

/** A resolved config with the knobs a deployment may pin. */
function config(overrides: Partial<ResolvedHermesConfig> = {}): ResolvedHermesConfig {
  return { bin: 'hermes', env: {}, model: undefined, reasoning: undefined, ...overrides }
}

/** Boot the services, with a session at the given cwd. */
async function harness(options: { cwd?: string | undefined } = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.prepare(SessionId(`hermes-${Math.random().toString(36).slice(2)}`), {
    meta: { ...options.cwd === undefined ? {} : { cwd: options.cwd } },
  })
  ctx.sessions.enter(session)
  return { ctx, session }
}

/** Build one agent on a prepared session. */
async function agentWith(
  spawnOptions: Parameters<typeof fakeSpawn>[0] = {},
  options: { cwd?: string | undefined; config?: Partial<ResolvedHermesConfig> } = {},
): Promise<{ ctx: Context; session: Session; agent: HermesAgent; spawned: Spawned[] }> {
  const { ctx, session } = await harness(options)
  const { spawn, spawned } = fakeSpawn(spawnOptions)
  const agent = new HermesAgent(
    ctx,
    session.header.id,
    { provider: 'external' } as never,
    session,
    config(options.config),
    spawn,
  )
  return { ctx, session, agent, spawned }
}

describe('one completed step', () => {
  it('spawns `hermes -z` with the serialized prompt and lands the answer', async () => {
    const { ctx, session, agent, spawned } = await agentWith(
      { stdout: 'PONG\n' },
      { cwd: '/work', config: { model: 'hermes-4', reasoning: 'high', env: { HERMES_HOME: '/alt' } } },
    )
    try {
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      const call = spawned[0]!
      expect(call.argv.slice(0, 2)).toEqual(['hermes', '-z'])
      // The prompt is the SERIALIZED transcript, not the raw message text.
      expect(call.argv[2]).toContain('say PONG')
      expect(call.argv[2]).toContain('<user>')
      expect(call.argv[call.argv.indexOf('-m') + 1]).toBe('hermes-4')
      expect(call.argv[call.argv.indexOf('--reasoning') + 1]).toBe('high')
      expect(call.cwd).toBe('/work')
      // A deployment pointing at a second Hermes profile carries the override.
      expect(call.env).toEqual({ HERMES_HOME: '/alt' })

      // One assistant message, shaped like a streaming engine's answer.
      const message = session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(message?.data).toMatchObject({
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'external' },
          content: [{ type: 'text', text: expect.stringContaining('PONG') }],
        },
      })
      // The stream member exists even though a text engine streams nothing, so a
      // replay of this transcript cannot tell it from a streaming engine's.
      expect(message?.data).toHaveProperty('stream')
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'completed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits -m and --reasoning when the deployment pinned neither', async () => {
    const { ctx, agent, spawned } = await agentWith({ stdout: 'ok' }, { cwd: '/work' })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned[0]!.argv).not.toContain('-m')
      expect(spawned[0]!.argv).not.toContain('--reasoning')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('passes the bare name when the deployment pinned no executable', async () => {
    const { ctx, agent, spawned } = await agentWith({ stdout: 'ok' }, { cwd: '/work', config: { bin: undefined } })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned[0]!.argv[0]).toBe('hermes')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the child’s own trailing whitespace in the answer', async () => {
    // The adapter hands stdout back verbatim; trimming would silently rewrite
    // what the engine produced.
    const { ctx, session, agent } = await agentWith({ stdout: '  spaced  \n' }, { cwd: '/work' })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const message = session.snapshotEvents().find(event => event.type === 'assistant/message')
      const content = (message?.data as { message: { content: Array<{ text: string }> } }).message.content
      expect(content[0]!.text).toBe('  spaced  \n')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('what the driver refuses rather than degrades', () => {
  it('refuses a step that carries images', async () => {
    const { ctx, session, agent, spawned } = await agentWith({ stdout: 'ok' }, { cwd: '/work' })
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
        reason: { kind: 'error', error: { message: expect.stringMatching(/Hermes Agent cannot receive images/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a step with no working directory', async () => {
    const { ctx, session, agent, spawned } = await agentWith({ stdout: 'ok' }, { cwd: undefined })
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
    const { ctx, agent } = await agentWith({ stdout: 'ok' }, { cwd: '/work' })
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

  it('reports the child’s stderr when it exits non-zero', async () => {
    // A failed login is the common case, and the CLI says so on stderr: that
    // text is the whole diagnostic, so it must reach the turn's ending.
    const { ctx, session, agent } = await agentWith(
      { stdout: '', stderr: 'hermes: no provider configured\n', exitCode: 1 },
      { cwd: '/work' },
    )
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: 'hermes: no provider configured' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a non-zero exit with no stderr as the exit code', async () => {
    const { ctx, session, agent } = await agentWith({ stdout: '', exitCode: 3 }, { cwd: '/work' })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: expect.stringMatching(/exited with code 3/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a clean exit with no output as "produced no output"', async () => {
    // The silent-success bug this plugin exists not to ship: an exit 0 with an
    // empty stdout is a failure, not an empty but fine answer.
    const { ctx, session, agent } = await agentWith({ stdout: '  \n', exitCode: 0 }, { cwd: '/work' })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: 'the engine produced no output' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the loop module', () => {
  it('exposes its ctx key and builds its own agent type', async () => {
    const plugin = loopPluginFor(HermesLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, { model: 'hermes-4' }, 'stub')
    try {
      expect(ctx.get('agentLoopHermes')).toBeDefined()
      const { agent } = await ctx.agents.create({ sessionId: SessionId('built'), meta: { cwd: '/work' } })
      expect(agent.constructor.name).toBe('HermesAgent')
      expect(HERMES_ENGINE).toBe('hermes')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves an empty bin to "not pinned" rather than to an empty path', async () => {
    // `bin: ''` means "I did not decide". The resolver answers `undefined`, and
    // the AGENT then falls back to the PATH name — so the resolved config must
    // not carry an empty string that would become an empty argv[0].
    const plugin = loopPluginFor(HermesLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, { bin: '' }, 'stub')
    try {
      const loop = ctx.get('agentLoopHermes') as { config: { bin?: string } } | undefined
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
      expect(() => new HermesLoop(ctx, {})).toThrow(/the hermes engine needs the dsh subprocess service/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the sink’s own verdict', () => {
  it('reports a sink that refused the answer, rather than claiming success', async () => {
    // `commitWholeMessage` can still leave the run failed. Returning
    // `{kind:'completed'}` after a reported failure is exactly the silent-success
    // bug this plugin exists not to ship, so the driver surfaces the verdict.
    const { ctx, agent, session } = await agentWith({ stdout: 'ok' }, { cwd: '/work' })
    try {
      // The transcript is the session's, not the argument list, so the log has
      // to hold a message before the prompt can be derived.
      session.append('user/message', userMessage('hi'), { surfaceOp: 'append' })
      const sink = (agent as unknown as { sink: { finish: (p: unknown) => unknown } }).sink
      vi.spyOn(sink, 'finish').mockReturnValue({
        kind: 'failed',
        message: 'the engine ended the run without producing a reply',
      })
      await expect(
        (agent as unknown as {
          runStep: (m: readonly UserMessage[], p: { turn: number; step: number }, s: AbortSignal) => Promise<unknown>
        }).runStep([userMessage('hi')], { turn: 1, step: 1 }, new AbortController().signal),
      ).rejects.toThrow(/ended the run without producing a reply/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('a dsh model handed to Hermes', () => {
  it('rides the child environment and the argv, keeping the user home in force', async () => {
    const { ctx, session, agent, spawned } = await agentWith(
      { stdout: 'PONG\n' },
      { cwd: '/work', config: { env: { HERMES_HOME: 'D:/HermesData/hermes-home' } } },
    )
    try {
      // The host's `modelSelection` fold: a `model/selection` event is read back
      // as the pending selection the driver resolves a model from.
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      provideDshEndpoint(ctx, { api: 'openai-completions' })
      session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      // The endpoint and credential travel as environment, and the user's own
      // HERMES_HOME rides along — this handover costs the engine nothing.
      expect(spawned[0]!.env).toMatchObject({
        OPENAI_BASE_URL: DSH_ENDPOINT.baseURL,
        OPENAI_API_KEY: DSH_ENDPOINT.apiKey,
        HERMES_HOME: 'D:/HermesData/hermes-home',
      })
      // `--provider openai` is load-bearing: without it Hermes' own `custom:` table
      // wins and the child dials the user's vendor instead.
      expect(spawned[0]!.argv).toContain('--provider')
      expect(spawned[0]!.argv).toEqual(expect.arrayContaining(['--provider', 'openai', '-m', DSH_ENDPOINT.model]))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a dsh model whose endpoint dsh cannot disclose, before spawning', async () => {
    const { ctx, session, agent, spawned } = await agentWith({ stdout: 'PONG\n' }, { cwd: '/work' })
    try {
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      session.append('model/selection', { provider: 'minimax', model: 'MiniMax-M3.1-Flash' })
      agent.followup(userMessage('hi'))
      await agent.whenIdle()

      // No child at all: a name Hermes' provider table has never heard of can only
      // come back as a provider error that names neither cause nor cure.
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
