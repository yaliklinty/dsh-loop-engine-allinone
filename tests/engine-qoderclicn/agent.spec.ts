/**
 * The Qoder CN driver end to end: a real session, a scripted stream-json child.
 *
 * Qoder speaks the `--output-format stream-json` family (the same shape Claude
 * Code's CLI prints), so this is where the SHARED stream-json path is pinned
 * from a driver's side: which documents become which durable events, what the
 * driver does with a child that printed nothing parseable, and how the
 * permission mode is resolved from the session's own knobs rather than guessed.
 *
 * The child is faked at the spawn capability — the assertions are about the
 * driver's decisions, not about a CLI. Real protocol captures live in
 * the fork's probe report; the frame vocabulary itself is pinned by
 * `tests/driver-cli/stream-json.spec.ts`.
 *
 * @module tests/engine-qoderclicn/agent
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { QoderclicnLoop } from '../../src/engine-qoderclicn/loop.ts'
import {
  QoderclicnAgent,
  QODERCLICN_ENGINE,
  type ResolvedQoderclicnConfig,
} from '../../src/engine-qoderclicn/agent.ts'
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
 * A fake spawn capability that prints the given NDJSON documents, one per line.
 *
 * `exitCode` is how the child dies; the transport's `done` settles immediately.
 */
function fakeSpawn(
  documents: readonly unknown[] = [],
  options: {
    exitCode?: number | null
    /** Observe the request while the child is alive (a handover root is transient). */
    onSpawn?: (request: { argv: readonly string[]; cwd: string; env: Record<string, string> }) => void
  } = {},
) {
  const spawned: Spawned[] = []
  const text = documents.map(document => JSON.stringify(document)).join('\n')
  const spawn = vi.fn((request: { argv: readonly string[]; cwd: string; env: Record<string, string> }) => {
    options.onSpawn?.(request)
    spawned.push({ argv: request.argv, cwd: request.cwd, env: request.env })
    const stream = (payload: string) => (async function* () {
      if (payload !== '') yield Buffer.from(`${payload}\n`, 'utf8')
    })()
    return {
      stdin: undefined,
      stdout: stream(text),
      stderr: stream(''),
      done: Promise.resolve({ exitCode: options.exitCode === undefined ? 0 : options.exitCode }),
      terminate: vi.fn(),
    }
  })
  return { spawn: spawn as never, spawned }
}

/** A resolved config with the knobs a deployment may pin. */
function config(overrides: Partial<ResolvedQoderclicnConfig> = {}): ResolvedQoderclicnConfig {
  return { bin: 'qoderclicn', env: {}, model: undefined, permissionMode: undefined, ...overrides }
}

/** Boot the services, with a session at the given cwd. */
async function harness(options: { cwd?: string | undefined } = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.prepare(SessionId(`qoder-${Math.random().toString(36).slice(2)}`), {
    meta: { ...options.cwd === undefined ? {} : { cwd: options.cwd } },
  })
  ctx.sessions.enter(session)
  return { ctx, session }
}

/** Build one agent on a prepared session. */
async function agentWith(
  documents: readonly unknown[] = [],
  options: {
    cwd?: string | undefined
    config?: Partial<ResolvedQoderclicnConfig>
    exitCode?: number | null
    onSpawn?: (request: { argv: readonly string[]; cwd: string; env: Record<string, string> }) => void
  } = {},
): Promise<{ ctx: Context; session: Session; agent: QoderclicnAgent; spawned: Spawned[] }> {
  const { ctx, session } = await harness(options)
  const { spawn, spawned } = fakeSpawn(documents, { exitCode: options.exitCode, onSpawn: options.onSpawn })
  const agent = new QoderclicnAgent(
    ctx,
    session.header.id,
    { provider: 'external' } as never,
    session,
    config(options.config),
    spawn,
  )
  return { ctx, session, agent, spawned }
}

/** One assistant document carrying the given content blocks. */
const assistant = (...content: unknown[]): unknown => ({
  type: 'assistant',
  session_id: 'sess-1',
  message: { role: 'assistant', content },
})

/** The result document that ends a run. */
const result = (payload: Partial<Record<string, unknown>> = {}): unknown => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'PONG',
  usage: { input_tokens: 3, output_tokens: 4 },
  ...payload,
})

describe('one completed step', () => {
  it('spawns the verified argv and lands the streamed answer', async () => {
    const { ctx, session, agent, spawned } = await agentWith(
      [assistant({ type: 'text', text: 'PONG' }), result()],
      { cwd: '/work', config: { model: 'qwen3-coder-plus', env: { A: '1' } } },
    )
    try {
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      const call = spawned[0]!
      // `--output-format stream-json` is what makes the answer structured, and
      // the prompt is LAST because `-p` takes it positionally.
      expect(call.argv.slice(0, 5)).toEqual(['qoderclicn', '-p', '--output-format', 'stream-json', '--permission-mode'])
      expect(call.argv.at(-1)).toContain('say PONG')
      expect(call.argv[call.argv.indexOf('-m') + 1]).toBe('qwen3-coder-plus')
      expect(call.cwd).toBe('/work')
      expect(call.env).toEqual({ A: '1' })

      const message = session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(message?.data).toMatchObject({
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'external' },
          content: [{ type: 'text', text: 'PONG' }],
        },
      })
      // The engine's own usage reached the log.
      expect((message?.data as { usage?: unknown }).usage).toMatchObject({ inputTokens: 3, outputTokens: 4 })
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'completed' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('pairs a tool call with its result across documents', async () => {
    const { ctx, session, agent } = await agentWith([
      assistant({ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file.txt', is_error: false }] } },
      assistant({ type: 'text', text: 'listed' }),
      result(),
    ], { cwd: '/work' })
    try {
      agent.followup(userMessage('list the files'))
      await agent.whenIdle()

      const types = session.snapshotEvents().map(event => event.type)
      expect(types).toContain('tool/call')
      expect(types).toContain('tool/result')
      // The durable log reads assistant/message → tool/call → tool/result.
      expect(types.indexOf('assistant/message')).toBeLessThan(types.indexOf('tool/call'))
      expect(types.indexOf('tool/call')).toBeLessThan(types.indexOf('tool/result'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a failed run the engine itself declared', async () => {
    const { ctx, session, agent } = await agentWith(
      [{ type: 'result', subtype: 'success', is_error: true, result: 'rate limited' }],
      { cwd: '/work' },
    )
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: 'rate limited' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('what the driver refuses rather than degrades', () => {
  it('fails a child that printed nothing parseable, quoting the last line', async () => {
    // A missing binary, an unsigned login or an unknown flag all look like this:
    // the child runs, prints prose, and never speaks the protocol. Reporting it
    // as an empty answer would be the silent degradation this plugin exists not
    // to produce.
    const { ctx, session, agent } = await agentWith([], { cwd: '/work' })
    try {
      // Replace the spawn with one that prints a non-JSON line.
      const spawn = vi.fn(() => {
        const stream = (payload: string) => (async function* () {
          if (payload !== '') yield Buffer.from(`${payload}\n`, 'utf8')
        })()
        return {
          stdin: undefined,
          stdout: stream('error: not signed in'),
          stderr: stream(''),
          done: Promise.resolve({ exitCode: 0 }),
          terminate: vi.fn(),
        }
      })
      const failing = new QoderclicnAgent(
        ctx,
        session.header.id,
        { provider: 'external' } as never,
        session,
        config(),
        spawn as never,
      )
      failing.followup(userMessage('hi'))
      await failing.whenIdle()

      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: {
          kind: 'error',
          error: { message: expect.stringMatching(/produced no stream-json on its protocol channel; last line: error: not signed in/) },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a step that carries images', async () => {
    const { ctx, session, agent, spawned } = await agentWith([result()], { cwd: '/work' })
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
        reason: { kind: 'error', error: { message: expect.stringMatching(/Qoder CN cannot receive images/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a step with no working directory', async () => {
    const { ctx, session, agent, spawned } = await agentWith([result()], { cwd: undefined })
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
    const { ctx, agent } = await agentWith([result()], { cwd: '/work' })
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
})

describe('the permission mode', () => {
  it('uses the pinned mode when the deployment set one', async () => {
    const { ctx, agent, spawned } = await agentWith([result()], {
      cwd: '/work',
      config: { permissionMode: 'bypass_permissions' },
    })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned[0]!.argv[spawned[0]!.argv.indexOf('--permission-mode') + 1]).toBe('bypass_permissions')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('derives the mode from the session’s knobs when nothing is pinned', async () => {
    // Qoder's mode is a function of the session's own sandbox/approval state,
    // and the mapping fails CLOSED: an unrecognised combination must not read as
    // "allow everything".
    const { ctx, agent, spawned } = await agentWith([result()], { cwd: '/work' })
    try {
      agent.session.append('sandbox/mode', { mode: 'danger-full-access' } as never)
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const mode = spawned[0]!.argv[spawned[0]!.argv.indexOf('--permission-mode') + 1]
      expect(mode).toBe('bypass_permissions')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the loop module', () => {
  it('exposes its ctx key and builds its own agent type', async () => {
    const plugin = loopPluginFor(QoderclicnLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, { model: 'qwen3-coder-plus' }, 'stub')
    try {
      expect(ctx.get('agentLoopQoderclicn')).toBeDefined()
      const { agent } = await ctx.agents.create({ sessionId: SessionId('built'), meta: { cwd: '/work' } })
      expect(agent.constructor.name).toBe('QoderclicnAgent')
      expect(QODERCLICN_ENGINE).toBe('qoderclicn')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the session it was asked to build when there is no subprocess service', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    try {
      expect(() => new QoderclicnLoop(ctx, {})).toThrow(/the qoderclicn engine needs the dsh subprocess service/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the two default arms', () => {
  it('falls back to the PATH name when no executable is pinned', async () => {
    // `config.bin ?? 'qoderclicn'`: a deployment that pins nothing gets the
    // PATH-resolved CLI, not an empty argv[0].
    const { ctx, agent, spawned } = await agentWith([result()], {
      cwd: '/work',
      config: { bin: undefined },
    })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned[0]!.argv[0]).toBe('qoderclicn')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('omits the last-line detail when the child printed nothing at all', async () => {
    // An empty protocol channel and a garbage protocol channel are different
    // failures; the message must not claim a "last line" it does not have.
    const { ctx, session } = await harness({ cwd: '/work' })
    try {
      const spawn = vi.fn(() => {
        const empty = (async function* () {})()
        return {
          stdin: undefined,
          stdout: empty,
          stderr: (async function* () {})(),
          done: Promise.resolve({ exitCode: 0 }),
          terminate: vi.fn(),
        }
      })
      const agent = new QoderclicnAgent(
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

describe("a Qoder CN's own catalog model", () => {
  it('hands the engine-native id to -m and opens no handover config root', async () => {
    const { ctx, session, agent, spawned } = await agentWith(
      [assistant({ type: 'text', text: 'PONG' }), result()],
      { cwd: '/work' },
    )
    try {
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      // The provider is Qoder's own route label now that its row declares a
      // catalog; the id is the engine's vocabulary, not a dsh `provider/model`.
      session.append('model/selection', { provider: 'qoderclicn', model: 'Auto' })
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      const argv = spawned[0]!.argv
      expect(argv).toContain('-m')
      expect(argv[argv.indexOf('-m') + 1]).toBe('Auto')
      // A native model needs neither dsh's endpoint nor a private root.
      expect(argv).not.toContain('--config-dir')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('a dsh model handed to Qoder CN', () => {
  /** Scratch login roots and the environment variable this suite borrows. */
  const roots: string[] = []
  const previousConfigDir = process.env.QODER_CONFIG_DIR

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    if (previousConfigDir === undefined) delete process.env.QODER_CONFIG_DIR
    else process.env.QODER_CONFIG_DIR = previousConfigDir
  })

  /** A fake signed-in root: the handover copies `.auth` out of one of these. */
  function signedInRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-qoder-source-'))
    mkdirSync(join(root, '.auth'))
    writeFileSync(join(root, '.auth', 'user.json'), '{"uid":"user-1"}')
    writeFileSync(join(root, 'installation_id'), 'install-1')
    roots.push(root)
    return root
  }

  it('runs the child in a private config root carrying the endpoint, key and model', async () => {
    process.env.QODER_CONFIG_DIR = signedInRoot()
    const seen: { dir?: string; settings?: string; authFile?: boolean; installId?: string } = {}
    const { ctx, session, agent, spawned } = await agentWith(
      [assistant({ type: 'text', text: 'PONG' }), result()],
      {
        cwd: '/work',
        // Read while the child is alive: the root is single-use and removed when
        // the step ends.
        onSpawn: request => {
          const index = request.argv.indexOf('--config-dir')
          const dir = index < 0 ? undefined : request.argv[index + 1]
          seen.dir = dir
          if (dir === undefined) return
          seen.settings = readFileSync(join(dir, 'settings.json'), 'utf8')
          seen.authFile = existsSync(join(dir, '.auth', 'user.json'))
          seen.installId = readFileSync(join(dir, 'installation_id'), 'utf8')
        },
      },
    )
    try {
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      provideDshEndpoint(ctx, { api: 'anthropic-messages' })
      session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      // The child gets a private root, and that root authenticates by copying the
      // user's login state — never by pointing at (or editing) `~/.qoder-cn`.
      expect(seen.dir).toBeDefined()
      expect(seen.authFile).toBe(true)
      expect(seen.installId).toBe('install-1')

      const settings = JSON.parse(seen.settings ?? '') as {
        providers: Record<string, {
          protocol: string
          baseUrl: string
          apiKey: string
          model: string
          models: Array<{ model: string }>
        }>
      }
      expect(settings.providers['dsh-handover']).toMatchObject({
        protocol: 'anthropic',
        baseUrl: DSH_ENDPOINT.baseURL,
        apiKey: DSH_ENDPOINT.apiKey,
        model: DSH_ENDPOINT.model,
      })
      expect(settings.providers['dsh-handover']!.models.map(entry => entry.model)).toEqual([DSH_ENDPOINT.model])

      // `-m <provider>/<model>` is how Qoder selects a custom-provider model.
      expect(spawned[0]!.argv).toContain('--config-dir')
      expect(spawned[0]!.argv).toContain('-m')
      expect(spawned[0]!.argv[spawned[0]!.argv.indexOf('-m') + 1]).toBe(`dsh-handover/${DSH_ENDPOINT.model}`)

      // One step, one root.
      expect(existsSync(seen.dir!)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a dsh model whose endpoint dsh cannot disclose, before spawning', async () => {
    process.env.QODER_CONFIG_DIR = signedInRoot()
    const { ctx, session, agent, spawned } = await agentWith(
      [assistant({ type: 'text', text: 'PONG' }), result()],
      { cwd: '/work' },
    )
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

  it('refuses before spawning when the user has no Qoder login to copy', async () => {
    // A root without `.auth`: the message must name the login command rather than
    // letting the child fail with a generic protocol error.
    const empty = mkdtempSync(join(tmpdir(), 'dsh-qoder-source-'))
    roots.push(empty)
    process.env.QODER_CONFIG_DIR = empty
    const { ctx, session, agent, spawned } = await agentWith(
      [assistant({ type: 'text', text: 'PONG' }), result()],
      { cwd: '/work' },
    )
    try {
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      provideDshEndpoint(ctx, { api: 'anthropic-messages' })
      session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(userMessage('hi'))
      await agent.whenIdle()

      expect(spawned).toHaveLength(0)
      const end = session.snapshotEvents().at(-1)
      expect(end).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
      expect(JSON.stringify(end)).toContain('qoderclicn login')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
