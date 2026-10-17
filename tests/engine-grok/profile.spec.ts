/**
 * Grok Build's dialect: the executable, the argv, and the auth-gated handshake.
 *
 * Every assertion here is a MEASURED fact about the real CLI (frames in
 * `output/probes/grok.acp.md`), which is why the fixtures look the way they do:
 * `session/new` refusing an unauthenticated client with `-32000 Authentication
 * required / "no auth method id provided"`, `authenticate` validating its method
 * id (`-32602 unsupported auth method: …`), and `promptCapabilities.image: false`.
 *
 * @module tests/engine-grok/profile
 */

import { describe, expect, it, vi } from 'vitest'
import {
  GROK_MODEL_CONFIG_ID,
  firstAuthMethodId,
  grokProfile,
  isAuthenticationRequired,
  selectGrokModel,
} from '../../src/engine-grok/profile.ts'
import { grokAcpArgv, grokBinResolver, grokHomeDir } from '../../src/engine-grok/process.ts'
import type { AcpClient } from '../../src/driver-acp/client.ts'
import type { Session } from '@deepseek-ai/dsh-session'

/** A session whose durable log is empty (the approval knob is unset). */
const session = { snapshotEvents: () => [] } as unknown as Session

/** The measured `initialize` result of grok 1.0.59. */
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  authMethods: [{ id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' }],
  agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
}

/** A fake client recording every call the profile makes. */
function fakeClient(overrides: Partial<Record<'newSession' | 'authenticate', unknown>> = {}): {
  client: AcpClient
  calls: { newSession: unknown[][]; authenticate: unknown[][]; setConfigOption: unknown[][]; setConfigOptionValue: unknown[][] }
} {
  const calls = { newSession: [] as unknown[][], authenticate: [] as unknown[][], setConfigOption: [] as unknown[][], setConfigOptionValue: [] as unknown[][] }
  const client = {
    newSession: vi.fn(async (...args: unknown[]) => {
      calls.newSession.push(args)
      const answer = overrides.newSession
      if (answer instanceof Error) throw answer
      return (answer as string | undefined) ?? 'sess_grok'
    }),
    authenticate: vi.fn(async (...args: unknown[]) => { calls.authenticate.push(args); return {} }),
    setConfigOption: vi.fn(async (...args: unknown[]) => { calls.setConfigOption.push(args); return {} }),
    setConfigOptionValue: vi.fn(async (...args: unknown[]) => { calls.setConfigOptionValue.push(args); return {} }),
  } as unknown as AcpClient
  return { client, calls }
}

describe("grok's ACP dialect", () => {
  it('announces the registry protocol version and refuses images', () => {
    const profile = grokProfile('grok')
    expect(profile.engine).toBe('grok')
    expect(profile.protocolVersion).toBe(1)
    // Measured: `promptCapabilities.image: false` — the shared body keeps image
    // blocks out of the prompt entirely for this engine.
    expect(profile.images).toBe(false)
    expect(profile.errorCode).toBe('GROK_NO_RESULT')
  })

  it('launches `grok agent stdio` without an approval flag', () => {
    // `--always-approve` is deliberately NOT in argv: the per-session switch is
    // `session/new`'s `_meta.yoloMode`, so the argv stays the same for every
    // session the child serves.
    expect(grokAcpArgv('grok')).toEqual(['grok', 'agent', 'stdio'])
    expect(grokAcpArgv('grok')).not.toContain('--always-approve')
  })

  it('resolves the executable from the vendor install location before PATH', () => {
    expect(grokHomeDir()).toContain('.grok')
    // An explicit pin always wins, and is returned verbatim.
    expect(grokBinResolver('/opt/x/grok')).toBe('/opt/x/grok')
    expect(grokBinResolver('')).not.toBe('')
  })

  it('reads the auth method id out of the initialize result', () => {
    expect(firstAuthMethodId(INITIALIZE_RESULT)).toBe('grok.com')
    expect(firstAuthMethodId({ authMethods: [] })).toBeUndefined()
    expect(firstAuthMethodId(undefined)).toBeUndefined()
    expect(firstAuthMethodId({ authMethods: [{ name: 'no id' }, { id: 'second' }] })).toBe('second')
  })

  it('recognizes the measured authentication refusal and nothing else', () => {
    expect(isAuthenticationRequired(new Error('Authentication required'))).toBe(true)
    expect(isAuthenticationRequired(new Error('Not authenticated'))).toBe(true)
    expect(isAuthenticationRequired(new Error('Method not found'))).toBe(false)
    expect(isAuthenticationRequired('plain string failure')).toBe(false)
  })

  it('authenticates with the advertised method, then opens the session', async () => {
    const { client, calls } = fakeClient()
    // First call refuses (measured), the retry succeeds once `authenticate` ran.
    let attempt = 0
    client.newSession = vi.fn(async () => {
      attempt += 1
      calls.newSession.push([])
      if (attempt === 1) throw new Error('Authentication required')
      return 'sess_after_auth'
    }) as unknown as typeof client.newSession
    const sessionId = await grokProfile('grok').openSession!(client, 'D:/w', session, INITIALIZE_RESULT)
    expect(sessionId).toBe('sess_after_auth')
    expect(attempt).toBe(2)
    // The method id is the one the agent PUBLISHED, never a guess.
    expect(calls.authenticate).toEqual([['grok.com']])
  })

  it('asks the agent to authenticate exactly once, with the published method id', async () => {
    const { client, calls } = fakeClient({ newSession: new Error('Authentication required') })
    await expect(grokProfile('grok').openSession!(client, 'D:/w', session, INITIALIZE_RESULT))
      .rejects.toThrow(/run `grok` once/)
    expect(calls.authenticate).toEqual([['grok.com']])
    // One retry, never a loop: two `session/new` attempts and one authenticate.
    expect(calls.newSession.length).toBe(2)
  })

  it('reports the login hint when `authenticate` ITSELF takes the child down', async () => {
    // Measured on this fork's host: on a signed-out machine `authenticate` starts
    // the vendor's browser sign-in, so with no terminal the child exits and the
    // shared client rejects with "grok acp process exited unexpectedly". That
    // message is unactionable, so the profile has to turn it into the registry's
    // login hint — which it can only do if the `authenticate` call sits inside the
    // same catch as the retry.
    const { client, calls } = fakeClient({ newSession: new Error('Authentication required') })
    ;(client as unknown as { authenticate: () => Promise<never> }).authenticate = vi.fn(async () => {
      calls.authenticate.push([])
      throw new Error('grok acp process exited unexpectedly')
    })
    const error = await grokProfile('grok').openSession!(client, 'D:/w', session, INITIALIZE_RESULT)
      .catch((thrown: unknown) => thrown)
    expect(String(error)).toMatch(/run `grok` once/)
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(String((error as Error).cause)).toContain('process exited unexpectedly')
    // It did NOT go on to retry `session/new` against a dead child.
    expect(calls.newSession.length).toBe(1)
  })

  it('reports the registry login hint when authenticating still does not open a session', async () => {
    const { client, calls } = fakeClient({ newSession: new Error('Authentication required') })
    const error = await grokProfile('grok').openSession!(client, 'D:/w', session, INITIALIZE_RESULT).catch((thrown: unknown) => thrown)
    expect(String(error)).toContain('grok login')
    // The cause is preserved so a reader can still see the engine's own words.
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(calls.authenticate.length).toBe(1)
  })

  it('does not swallow an unrelated session/new failure', async () => {
    const { client } = fakeClient({ newSession: new Error('Invalid params') })
    await expect(grokProfile('grok').openSession!(client, 'D:/w', session, INITIALIZE_RESULT))
      .rejects.toThrow('Invalid params')
  })

  it('passes no auth method when the agent advertised none', async () => {
    const { client, calls } = fakeClient({ newSession: new Error('Authentication required') })
    await expect(grokProfile('grok').openSession!(client, 'D:/w', session, { protocolVersion: 1 }))
      .rejects.toThrow('Authentication required')
    expect(calls.authenticate).toEqual([])
  })

  it('turns the session approval knob into `_meta.yoloMode`', async () => {
    const { client, calls } = fakeClient()
    await grokProfile('grok').openSession!(client, 'D:/w', session, INITIALIZE_RESULT)
    // No `approval/policy` event means knob-less, which the shared fold approves,
    // so the engine is told to run without prompts.
    expect(calls.newSession[0]).toEqual(['D:/w', { _meta: { yoloMode: true } }])

    const asking = {
      snapshotEvents: () => [{ type: 'approval/policy', data: { policy: 'ask' } }],
    } as unknown as Session
    const second = fakeClient()
    await grokProfile('grok').openSession!(second.client, 'D:/w', asking, INITIALIZE_RESULT)
    // Under `ask` the driver answers the reverse-RPC itself (denying), so the
    // engine is NOT pre-authorized.
    expect(second.calls.newSession[0]).toEqual(['D:/w', {}])
  })

  it('selects its model with the BARE value, which is the measured spelling', async () => {
    // Measured AFTER signing in: the `{ value }` wrapper the vendor documents is
    // REJECTED with `-32602 data did not match any variant of untagged enum
    // SessionConfigOptionValue`, while the bare string is ACCEPTED. So there is
    // no "documented first, fall back" dance — the wrapper is simply wrong here.
    const { client, calls } = fakeClient()
    await selectGrokModel(client, 'sess', 'grok-4.7')
    expect(calls.setConfigOption).toEqual([['sess', GROK_MODEL_CONFIG_ID, 'grok-4.7']])
    expect(GROK_MODEL_CONFIG_ID).toBe('model')
  })

  it('never sends the rejected wrapper, not even as a first attempt', async () => {
    const { client, calls } = fakeClient()
    await selectGrokModel(client, 'sess', 'grok-4.7')
    // One call, and it is the bare one: an engine that answers `-32602` to the
    // wrapper would otherwise burn a request per step on every step.
    expect(calls.setConfigOptionValue).toEqual([])
    expect(calls.setConfigOption.length).toBe(1)
  })

  it('propagates a model id the engine does not know', async () => {
    // Measured: a stale registry entry fails with `-32602 unknown model id`. That
    // must reach the user rather than being replaced by the engine's default.
    const { client } = fakeClient()
    ;(client as unknown as { setConfigOption: () => Promise<never> }).setConfigOption =
      vi.fn(async () => { throw new Error('Invalid params: unknown model id') })
    await expect(selectGrokModel(client, 'sess', 'grok-4.6')).rejects.toThrow(/unknown model id/)
  })
})
