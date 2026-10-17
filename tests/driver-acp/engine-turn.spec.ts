/**
 * Both new ACP engines driving a real session through the harness.
 *
 * The dialects have focused unit specs; THIS file is the claim that the engines
 * actually run — factory registration, a streamed turn landing in the durable log
 * with the right provenance, a tool call pairing its result, and each engine's own
 * handshake/model dialect reaching the (mocked) ACP client. The client is mocked
 * at the module boundary for the same reason the kimi engine's spec mocks it:
 * these assertions are about what the DRIVER does with frames, not about a CLI.
 *
 * @module tests/driver-acp/engine-turn
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { GrokLoop } from '../../src/engine-grok/loop.ts'
import { MinimaxcodeLoop } from '../../src/engine-minimaxcode/loop.ts'
import { loopPluginFor, mountHarness, userMessage as message } from '../helpers/agent-harness.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'

/** Hoisted mock client plus the scripted update stream and every recorded call. */
const mock = vi.hoisted(() => {
  const client = {
    initialize: vi.fn(async () => ({ protocolVersion: 1, authMethods: [{ id: 'grok.com', name: 'Grok' }] })),
    newSession: vi.fn(async () => 'sess_1'),
    setModel: vi.fn(async () => ({})),
    setConfigOption: vi.fn(async () => ({})),
    setConfigOptionValue: vi.fn(async () => ({})),
    setMode: vi.fn(async () => ({})),
    authenticate: vi.fn(async () => ({})),
    prompt: vi.fn(async () => {
      for (const update of mock.updates()) mock.updateHandler?.(update)
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(),
    onPermission: vi.fn(),
    onUpdate: vi.fn((handler: (update: Record<string, unknown>) => void) => { mock.updateHandler = handler }),
    dispose: vi.fn(),
    closed: false,
  }
  return {
    client,
    updates: vi.fn<() => Record<string, unknown>[]>(() => []),
    created: [] as Array<{ spec: { argv: readonly string[]; env: Record<string, string> }; options: unknown }>,
    updateHandler: undefined as ((update: Record<string, unknown>) => void) | undefined,
  }
})

vi.mock('../../src/driver-acp/client.ts', () => ({
  // The real `AcpClient` is a class with a static factory; the drivers only ever
  // reach it through `create`.
  AcpClient: {
    create: vi.fn((spec: { argv: readonly string[]; env: Record<string, string> }, _spawn: unknown, options: unknown) => {
      mock.created.push({ spec, options })
      return mock.client
    }),
  },
}))

/** Text chunk update. */
const text = (delta: string): Record<string, unknown> => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } })
/** Thought chunk update. */
const thought = (delta: string): Record<string, unknown> => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } })
/** Tool-call announcement, then the update that carries its input and result. */
const toolCall = (id: string, title: string): Record<string, unknown> => ({
  sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status: 'pending', content: [],
})
const toolDone = (id: string, output: string): Record<string, unknown> => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text: output } }],
  rawInput: { command: 'echo hi' },
})

/** The two engines under test, with the dialect calls each is expected to make. */
const ENGINES = {
  grok: { loop: GrokLoop, bin: '/opt/grok', model: 'grok-4.6' },
  minimaxcode: { loop: MinimaxcodeLoop, bin: '/opt/mcode/cli.js', model: 'm:minimax:MiniMax-M3:v:thinking' },
} as const

beforeEach(() => {
  mock.created.length = 0
  mock.updates.mockReset()
  mock.updates.mockReturnValue([])
  mock.updateHandler = undefined
  for (const fn of [
    mock.client.initialize, mock.client.newSession, mock.client.setModel, mock.client.setConfigOption,
    mock.client.setConfigOptionValue, mock.client.setMode, mock.client.authenticate, mock.client.prompt,
    mock.client.cancel, mock.client.onPermission, mock.client.onUpdate, mock.client.dispose,
  ]) fn.mockClear()
  mock.client.newSession.mockResolvedValue('sess_1')
  mock.client.closed = false
})

describe.each(Object.entries(ENGINES))('%s driving a session', (engine, spec) => {
  const loopPlugin = loopPluginFor(spec.loop, ['agents', 'sessions', 'systemPrompt', 'subprocess'])

  /** Mount the engine with its deployment-pinned model. */
  async function harness(): Promise<Context> {
    const ctx = await mountHarness(loopPlugin, { bin: spec.bin, model: spec.model }, 'stub')
    // The host's `modelSelection` fold, so a `model/selection` appended to the
    // session is read back as the pending selection the driver resolves a model
    // from — the same read the host's own `selectionFor` makes.
    ctx.provide('sessionProjections', modelSelectionProjections(ctx))
    return ctx
  }

  it('registers its factory, so a session can be created on it', async () => {
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('factory-s'), meta: { cwd: process.cwd() } })
      expect(agent.status).toBe('idle')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records streamed text and thinking as one assistant message with dsh provenance', async () => {
    mock.updates.mockReturnValue([thought('thinking…'), text('Hello '), text('world')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('text-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      const assistant = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
      expect(assistant).toMatchObject({
        data: {
          message: {
            role: 'assistant',
            source: { kind: 'model', provider: 'external' },
            content: [
              { type: 'reasoning', text: 'thinking…' },
              { type: 'text', text: 'Hello world' },
            ],
          },
        },
        surfaceOp: 'append',
      })
      // The header names the hosted route, so the session's model seat resolves
      // to the engine's own "default" entry rather than a dsh model.
      const header = agent.session.requestHeader()
      expect(header?.config?.provider).toBe('external')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('pairs an announced tool call with its result in the durable log', async () => {
    mock.updates.mockReturnValue([toolCall('call_1', 'Bash'), toolDone('call_1', 'hi')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('tool-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('run it'))
      await agent.whenIdle()

      const types = agent.session.snapshotEvents().map(event => event.type)
      expect(types).toContain('tool/call')
      expect(types).toContain('tool/result')
      const call = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
      // The call keeps the ENGINE's own tool title, not dsh's spelling: this
      // build has no VERIFIED tool vocabulary for either engine (no tool-call
      // frame was ever captured from a signed-in grok, and MiniMax Code answered
      // without calling a tool), and `normalizeHostedToolCall` passes an engine
      // with no row through unchanged on purpose — a guessed projection would
      // mis-render a call rather than leave it generic.
      expect(call?.data).toMatchObject({ name: 'Bash', arguments: JSON.stringify({ command: 'echo hi' }) })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('spawns its own ACP argv, announces the registry protocol version, and selects its model', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('dialect-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()

      // The argv is the ENGINE's own: `grok agent stdio` / `mcode acp` (through
      // node for the npm-installed entrypoint).
      const spec_ = mock.created[0]!.spec
      if (engine === 'grok') expect(spec_.argv.slice(1)).toEqual(['agent', 'stdio'])
      else expect(spec_.argv.slice(1)).toEqual([spec.bin, 'acp'])
      // The protocol version travels from the registry row, not a constant.
      expect(mock.created[0]!.options).toMatchObject({ protocolVersion: 1, label: engine })

      // Model selection uses THIS engine's dialect.
      if (engine === 'grok') {
        expect(mock.client.setConfigOptionValue).toHaveBeenCalledWith('sess_1', 'model', spec.model)
        // Grok gates a session it has not been authenticated for.
        expect(mock.client.newSession).toHaveBeenCalledWith(process.cwd(), { _meta: { yoloMode: true } })
      } else {
        expect(mock.client.setConfigOption).toHaveBeenCalledWith('sess_1', 'model', spec.model)
        expect(mock.client.newSession).toHaveBeenCalledWith(process.cwd())
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('states its permission stance through the engine\'s own switch', async () => {
    mock.updates.mockReturnValue([text('ok')])
    const ctx = await harness()
    try {
      const { agent } = await ctx.agents.create({ sessionId: SessionId('perm-s'), meta: { cwd: process.cwd() } })
      agent.followup(message('hi'))
      await agent.whenIdle()
      if (engine === 'minimaxcode') {
        // The engine's persisted default may be Full access, so the driver
        // always states the mode the session's knobs imply.
        expect(mock.client.setConfigOption).toHaveBeenCalledWith('sess_1', 'permissionMode', 'auto')
      } else {
        expect(mock.client.setConfigOptionValue).toHaveBeenCalledWith('sess_1', 'model', spec.model)
        expect(mock.client.authenticate).not.toHaveBeenCalled()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('an engine without the subprocess service', () => {
  it('fails the engine it was asked to build, by name', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    try {
      expect(() => new MinimaxcodeLoop(ctx, { bin: '/opt/mcode/cli.js' }))
        .toThrow(/the minimaxcode engine needs the dsh subprocess service/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
