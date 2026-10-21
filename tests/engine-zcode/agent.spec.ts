/**
 * The ZCode driver end to end: a real session, a faked `zcode -p` child.
 *
 * ZCode is the simplest of the four CLI engines — one child per step, prompt in
 * argv, the finished answer on stdout — which makes it the right place to pin
 * the shared "text engine" path precisely: what reaches the child, what lands in
 * the log, and every arm that REFUSES rather than degrading.
 *
 * The child is faked at the spawn capability, so the assertions are about the
 * driver's decisions (argv, cwd, mode, the provider-catalog variable) and about
 * the durable transcript. Nothing here claims `zcode` really answered — that is
 * what `scripts/probe/smoke-*.ts` and the live runs recorded in
 * the fork's probe report are for.
 *
 * @module tests/engine-zcode/agent
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { ZcodeLoop } from '../../src/engine-zcode/loop.ts'
import { ZcodeAgent, ZCODE_ENGINE, type ResolvedZcodeConfig } from '../../src/engine-zcode/agent.ts'
import { ZCODE_PERSONAL_PROVIDER_CONFIG_ENV } from '../../src/engine-zcode/model-handover.ts'
import { ZCODE_PROVIDER_CONFIG_ENV } from '../../src/engine-zcode/process.ts'
import { loopPluginFor, mountHarness, userMessage } from '../helpers/agent-harness.ts'
import { DSH_ENDPOINT, provideDshEndpoint } from '../helpers/dsh-model-endpoint.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'

/** One spawn the driver made, and the streams the fake handed back. */
interface Spawned {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } | undefined
}

/**
 * A fake spawn capability.
 *
 * `stdout` is what the child prints, `exitCode` how it dies, and `stderr` what it
 * complained about. The transport's `done` settles immediately, which is what the
 * text adapter awaits.
 */
function fakeSpawn(options: {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  error?: unknown
  /** Observe the request while the child is alive (the handover file is transient). */
  onSpawn?: (request: { argv: readonly string[]; cwd: string; env: Record<string, string> }) => void
} = {}) {
  const spawned: Spawned[] = []
  const spawn = vi.fn((request: { argv: readonly string[]; cwd: string; env: Record<string, string> }) => {
    options.onSpawn?.(request)
    const stdin = { write: vi.fn(), end: vi.fn() }
    spawned.push({ argv: request.argv, cwd: request.cwd, env: request.env, stdin })
    const stream = (text: string) => (async function* () {
      if (text !== '') yield Buffer.from(text, 'utf8')
    })()
    return {
      stdin: undefined,
      stdout: stream(options.stdout ?? ''),
      stderr: stream(options.stderr ?? ''),
      done: options.error === undefined
        ? Promise.resolve({ exitCode: options.exitCode === undefined ? 0 : options.exitCode })
        : Promise.reject(options.error),
      terminate: vi.fn(),
    }
  })
  return { spawn: spawn as never, spawned }
}

/** A resolved config with everything pinned. */
function config(overrides: Partial<ResolvedZcodeConfig> = {}): ResolvedZcodeConfig {
  return {
    prefix: ['zcode'],
    env: {},
    model: undefined,
    providerConfig: undefined,
    ...overrides,
  }
}

/** Boot the services an agent needs, with a session at the given cwd. */
async function harness(options: { cwd?: string | undefined } = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.prepare(SessionId(`zcode-${Math.random().toString(36).slice(2)}`), {
    meta: { ...options.cwd === undefined ? {} : { cwd: options.cwd } },
  })
  ctx.sessions.enter(session)
  return { ctx, session }
}

/** Build one agent on a prepared session. */
async function agentWith(
  spawnOptions: Parameters<typeof fakeSpawn>[0] = {},
  options: { cwd?: string | undefined; config?: Partial<ResolvedZcodeConfig> } = {},
): Promise<{ ctx: Context; session: Session; agent: ZcodeAgent; spawned: Spawned[] }> {
  const { ctx, session } = await harness(options)
  const { spawn, spawned } = fakeSpawn(spawnOptions)
  const agent = new ZcodeAgent(
    ctx,
    session.header.id,
    { provider: 'external' } as never,
    session,
    config(options.config),
    spawn,
  )
  return { ctx, session, agent, spawned }
}

/** The log's event types, without the inbox bookkeeping. */
function types(session: Session): string[] {
  return session.snapshotEvents()
    .map(event => event.type)
    .filter(type => !type.startsWith('agent/inbox/'))
}

/** The minimal structured stream: a text delta and the terminal envelope. */
function zstream(text: string): string {
  return [
    JSON.stringify({ type: 'model.streaming', payload: { kind: 'text_delta', delta: text } }),
    JSON.stringify({ type: 'turn.completed', payload: { response: text, resultType: 'success', usage: { inputTokens: 3, outputTokens: 2 } } }),
  ].join('\n') + '\n'
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('one completed step', () => {
  it('spawns `zcode -p` with the prompt, the mode and the provider catalog', async () => {
    const { ctx, session, agent, spawned } = await agentWith(
      { stdout: zstream('PONG\n') },
      { cwd: '/work', config: { model: 'glm-5', providerConfig: '/app/zcode-builtin.json', env: { A: '1' } } },
    )
    try {
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      const call = spawned[0]!
      // The prompt travels in argv, serialized from the durable log (the
      // transcript is the ONLY context the child gets); `--no-color` keeps the
      // answer free of ANSI.
      expect(call.argv.slice(0, 2)).toEqual(['zcode', '-p'])
      expect(call.argv[2]).toContain('say PONG')
      expect(call.argv[2]).toContain('<user>')
      expect(call.argv).toContain('--no-color')
      // `--model` is an unknown option in CLI 0.16.9 (`Unknown option '--model'`),
      // so a pinned label must never reach argv: the model comes from the
      // provider document instead.
      expect(call.argv).not.toContain('--model')
      // A session without full access runs `build`, not `yolo`.
      expect(call.argv[call.argv.indexOf('--mode') + 1]).toBe('build')
      expect(call.cwd).toBe('/work')
      // The discovered catalog is merged UNDER the deployment's own entries.
      expect(call.env).toMatchObject({ A: '1' })
      expect(Object.values(call.env)).toContain('/app/zcode-builtin.json')

      // The answer landed as one assistant message, and the turn completed.
      const assistant = session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant?.data).toMatchObject({
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'external' },
          // stdout verbatim, trailing newline included: the adapter does not
          // trim, because an engine's own whitespace is part of its answer.
          content: [{ type: 'text', text: 'PONG' + String.fromCharCode(10) }],
        },
      })
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({ reason: { kind: 'completed' } })
      expect(types(session)).toContain('request/header')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs `yolo` when the session has full access', async () => {
    const { ctx, agent, spawned } = await agentWith({ stdout: zstream('ok') }, { cwd: '/work' })
    try {
      // The mode is derived from the session's own permission knobs, not a flag.
      agent.session.append('sandbox/mode', { mode: 'danger-full-access' } as never)
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned[0]!.argv[spawned[0]!.argv.indexOf('--mode') + 1]).toBe('yolo')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never forwards a pinned model, which this CLI cannot accept', async () => {
    // Measured against 0.16.9: the flag is rejected outright. Keeping it out of
    // argv is what makes a deployment-level `model` label harmless.
    const { ctx, agent, spawned } = await agentWith({ stdout: zstream('ok') }, { cwd: '/work', config: { model: 'glm-5' } })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      expect(spawned[0]!.argv).not.toContain('--model')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends a multi-word prompt as ONE argv element', async () => {
    // The whole point of `-p <prompt>`: a prompt with spaces and newlines must
    // not be re-split by a shell. Nothing here goes through a shell, and this
    // pins that.
    const { ctx, agent, spawned } = await agentWith({ stdout: zstream('ok') }, { cwd: '/work' })
    try {
      agent.followup(userMessage('line one\nline two  with  spaces'))
      await agent.whenIdle()
      const prompt = spawned[0]!.argv[2]!
      // One argv element: the newlines and the runs of spaces survive verbatim
      // inside it, and nothing re-splits them on the way to the child.
      expect(prompt).toContain('line one' + String.fromCharCode(10) + 'line two  with  spaces')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('what the driver refuses rather than degrades', () => {
  it('refuses a step that carries images, naming the engine and the action', async () => {
    // ZCode declares `images: false`. Dropping the picture and sending the text
    // would look to the user like the engine read it.
    const { ctx, agent, spawned, session } = await agentWith({ stdout: zstream('ok') }, { cwd: '/work' })
    try {
      const withImage = createUserMessage({
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { kind: 'attachment', attachmentId: 'a1' } } as never,
        ],
        source: { kind: 'user' },
      }) as UserMessage
      agent.followup(withImage)
      await agent.whenIdle()

      // No child was ever spawned for a request the engine cannot honour.
      expect(spawned).toHaveLength(0)
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: expect.stringMatching(/ZCode cannot receive images \(1 attached/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a step with no working directory', async () => {
    const { ctx, agent, spawned, session } = await agentWith({ stdout: zstream('ok') }, { cwd: undefined })
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

  it('reports the child’s stderr when it exits non-zero', async () => {
    const { ctx, agent, session } = await agentWith(
      { stdout: '', stderr: 'zcode: not signed in\n', exitCode: 2 },
      { cwd: '/work' },
    )
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: 'zcode: not signed in' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a non-zero exit with no stderr as the exit code', async () => {
    const { ctx, agent, session } = await agentWith({ stdout: '', exitCode: 7 }, { cwd: '/work' })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: expect.stringMatching(/exited with code 7/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a clean exit with no protocol output as a protocol failure', async () => {
    const { ctx, agent, session } = await agentWith({ stdout: '   \n', exitCode: 0 }, { cwd: '/work' })
    try {
      agent.followup(userMessage('hi'))
      await agent.whenIdle()
      const end = session.snapshotEvents().find(event => event.type === 'turn/end')
      expect(end?.data).toMatchObject({
        reason: { kind: 'error', error: { message: expect.stringMatching(/produced no stream-json/) } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a spawn that rejected, rather than hanging the step', async () => {
    // A missing binary reaches the driver as a rejected `done`, not as an empty
    // answer: the step must fail with the seam's own words.
    const { ctx, agent, session } = await agentWith(
      { error: new Error('spawn zcode ENOENT') },
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
})

describe('a dsh model handed to ZCode', () => {
  it('writes a private provider document and points the child at it', async () => {
    let observedPath: string | undefined
    let observedDocument: string | undefined
    const { ctx, session, agent, spawned } = await agentWith(
      {
        stdout: zstream('PONG\n'),
        // Read while the child is alive: the document is single-use and removed
        // when the step ends.
        onSpawn: request => {
          observedPath = request.env[ZCODE_PERSONAL_PROVIDER_CONFIG_ENV]
          if (observedPath !== undefined) observedDocument = readFileSync(observedPath, 'utf8')
        },
      },
      { cwd: '/work', config: { providerConfig: '/app/zcode-builtin.json' } },
    )
    try {
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      provideDshEndpoint(ctx, { api: 'anthropic-messages' })
      session.append('model/selection', { provider: DSH_ENDPOINT.provider, model: DSH_ENDPOINT.model })
      agent.followup(userMessage('say PONG'))
      await agent.whenIdle()

      // Both provider files are named together: the CLI only short-circuits its
      // own (failing) catalog lookup when BOTH variables are set.
      expect(spawned[0]!.env[ZCODE_PERSONAL_PROVIDER_CONFIG_ENV]).toBe(observedPath)
      expect(spawned[0]!.env[ZCODE_PROVIDER_CONFIG_ENV]).toBe('/app/zcode-builtin.json')

      const document = JSON.parse(observedDocument ?? '') as {
        config: {
          providerOrder: string[]
          providerConfigRules: { providerRules: Array<{ config: { access: { apiKey: string }, api: { type: string, baseUrl: string } } }> }
          defaultModelSelection: { providerId: string, modelId: string }
        }
      }
      // The document carries dsh's endpoint, key and model under one custom
      // provider, and names that model as the default selection.
      expect(document.config.providerConfigRules.providerRules[0]!.config.api)
        .toEqual({ type: 'anthropic-messages', baseUrl: DSH_ENDPOINT.baseURL })
      expect(document.config.providerConfigRules.providerRules[0]!.config.access.apiKey).toBe(DSH_ENDPOINT.apiKey)
      expect(document.config.defaultModelSelection).toEqual({ providerId: 'dsh-handover', modelId: DSH_ENDPOINT.model })
      expect(document.config.providerOrder).toEqual(['dsh-handover'])

      // One step, one document: the temp file is gone once the child settles.
      expect(observedPath).toBeDefined()
      expect(existsSync(observedPath!)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a dsh model whose endpoint dsh cannot disclose, before spawning', async () => {
    const { ctx, session, agent, spawned } = await agentWith({ stdout: zstream('PONG\n') }, { cwd: '/work' })
    try {
      ctx.provide('sessionProjections', modelSelectionProjections(ctx))
      session.append('model/selection', { provider: 'minimax', model: 'MiniMax-M3.1-Flash' })
      agent.followup(userMessage('hi'))
      await agent.whenIdle()

      // No child at all: forwarding a name ZCode's provider table has never heard
      // of can only come back as a provider error that names neither cause nor cure.
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

describe('the loop module', () => {
  it('resolves its config, exposing the argv prefix and the catalog', async () => {
    // `resolveConfig` is where the bin pin becomes an argv prefix and the
    // discovered catalog is looked up; both are engine facts the agent reads.
    const plugin = loopPluginFor(ZcodeLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, { bin: '/opt/zcode.cjs', model: 'glm-5', env: { X: '1' } }, 'stub')
    try {
      const loop = ctx.get('agentLoopZcode') as { config: Record<string, unknown> } | undefined
      expect(loop?.config).toMatchObject({ model: 'glm-5', env: { X: '1' } })
      // A `.cjs` bundle runs under node; a native path is used as-is.
      expect((loop?.config as { prefix: string[] }).prefix).toHaveLength(2)
      expect((loop?.config as { prefix: string[] }).prefix[1]).toBe('/opt/zcode.cjs')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names its own ctx key, so a profile can introspect which engines were built', async () => {
    const plugin = loopPluginFor(ZcodeLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, {}, 'stub')
    try {
      expect(ctx.get('agentLoopZcode')).toBeDefined()
      expect(ZCODE_ENGINE).toBe('zcode')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the session it was asked to build when there is no subprocess service', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    try {
      expect(() => new ZcodeLoop(ctx, {})).toThrow(/the zcode engine needs the dsh subprocess service/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the empty-transcript and empty-answer arms', () => {
  it('refuses a step whose transcript yields no prompt', async () => {
    // The step's own messages are in the log, so a prompt always exists — unless
    // the log is read before they land. Driving `runStep` directly with an empty
    // history is the only way to reach the guard, and the guard exists so a
    // driver bug shows up as a clear error rather than as an empty argv.
    const { ctx, agent, spawned } = await agentWith({ stdout: zstream('ok') }, { cwd: '/work' })
    try {
      vi.spyOn(agent as never, 'history' as never).mockReturnValue([] as never)
      await expect(
        (agent as unknown as {
          runStep: (m: readonly UserMessage[], p: { turn: number; step: number }, s: AbortSignal) => Promise<unknown>
        }).runStep([], { turn: 1, step: 1 }, new AbortController().signal),
      ).rejects.toThrow(/cannot derive a prompt from an empty session log/)
      expect(spawned).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a sink that refused the answer, rather than claiming success', async () => {
    // `finish()` returns `failed` when the run committed nothing — the arm the
    // driver must turn into a thrown step instead of returning `completed`. The
    // sink is mocked at that one method because the condition it reports on
    // (an answer that never landed) is otherwise only reachable through a log
    // write failure, which would fail the test for the wrong reason.
    const { ctx, agent, session } = await agentWith({ stdout: zstream('ok') }, { cwd: '/work' })
    try {
      const sink = (agent as unknown as { sink: { finish: (p: unknown) => unknown } }).sink
      vi.spyOn(sink, 'finish').mockReturnValue({ kind: 'failed', message: 'the engine ended the run without producing a reply' })
      // The transcript is the session's, not the argument list, so the log has
      // to hold a message before the prompt can be derived.
      session.append('user/message', userMessage('hi'), { surfaceOp: 'append' })
      await expect(
        (agent as unknown as {
          runStep: (m: readonly UserMessage[], p: { turn: number; step: number }, s: AbortSignal) => Promise<unknown>
        }).runStep([userMessage('hi')], { turn: 1, step: 1 }, new AbortController().signal),
      ).rejects.toThrow(/ended the run without producing a reply/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('builds its agent through the loop’s own factory', async () => {
    // `buildAgent` is the subclass's one obligation; the loop hands it the
    // resolved config and the spawn capability, and the result must be the
    // engine's own driver type.
    const plugin = loopPluginFor(ZcodeLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, { model: 'glm-5' }, 'stub')
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('built'), meta: { cwd: '/work' } })
      expect(agent.constructor.name).toBe('ZcodeAgent')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the shared runtime’s spawn capability', () => {
  it('spawns through the seam with the engine’s grace period and stdin decision', async () => {
    // `CliEngineRuntime` wraps the dsh subprocess seam once for every CLI engine,
    // applying its grace period and whether the prompt travels on stdin. The
    // per-engine specs otherwise inject a fake capability straight into the
    // agent, which leaves that wrapper itself unexercised — so this drives a real
    // step through the mounted loop instead.
    const plugin = loopPluginFor(ZcodeLoop as never, ['agents', 'sessions', 'systemPrompt', 'subprocess'])
    const ctx = await mountHarness(plugin, {}, 'stub')
    const seen: Array<Record<string, unknown>> = []
    // Replace the stub the harness provided with one that answers like a child.
    ;(ctx.get('subprocess') as { spawn: unknown }).spawn = (spec: Record<string, unknown>) => {
      seen.push(spec)
      const stream = (payload: string) => Readable.from(payload === '' ? [] : [Buffer.from(payload, 'utf8')])
      return {
        stdin: undefined,
        stdout: stream('PONG\n'),
        stderr: stream(''),
        done: Promise.resolve({ exitCode: 0 }),
        terminate: () => {},
      }
    }
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('spawn'), meta: { cwd: '/work' } })
      agent.followup(userMessage('hi'))
      await agent.whenIdle()

      expect(seen).toHaveLength(1)
      const spec = seen[0]!
      // The seam is asked for the pipes the engine needs and the grace period the
      // engine declares; a text engine sends its prompt in argv, so no stdin pipe
      // is requested.
      expect(spec.stdio).toEqual({ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      expect(typeof spec.graceMs).toBe('number')
      expect(spec.cwd).toBe('/work')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
