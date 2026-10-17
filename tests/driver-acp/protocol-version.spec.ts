/**
 * The ACP protocol version is REGISTRY DATA, not a constant in the shared client.
 *
 * This is the regression pin for a real protocol-drift risk: three engines now
 * share one ACP skeleton (`driver-acp/`), and before this the version announced at
 * `initialize` was hardcoded inside that skeleton — so an engine that moved to a
 * different protocol version would have been advanced (or silently frozen) for all
 * of them at once. Two properties are pinned here:
 *
 *   1. kimi's behavior is UNCHANGED: its row declares 1, its profile announces 1,
 *      and the bytes on the wire are the ones the previous constant produced;
 *   2. the value a client announces is whatever its caller passes, and the ONE
 *      reader of the registry field is what those callers use — so a declaration
 *      cannot be missed by a driver that forgot to ask.
 *
 * @module tests/driver-acp/protocol-version
 */

import { readFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AcpClient } from '../../src/driver-acp/client.ts'
import type { AcpProcess } from '../../src/driver-acp/transport.ts'
import { grokProfile } from '../../src/engine-grok/profile.ts'
import { kimiProfile } from '../../src/engine-kimi/profile.ts'
import { minimaxcodeProfile } from '../../src/engine-minimaxcode/profile.ts'
import {
  DEFAULT_ACP_PROTOCOL_VERSION,
  ENGINE_DESCRIPTORS,
  ENGINE_REGISTRY,
  HOSTED_ENGINE_IDS,
  acpProtocolVersionOf,
  type HostedEngineId,
} from '../../src/engine-registry.ts'

/** A fake ACP process recording stdin writes. */
function fakeProcess(): { process: AcpProcess; writes: string[] } {
  const writes: string[] = []
  const stdin = new Writable({ write: (chunk, _encoding, callback) => { writes.push(chunk.toString()); callback() } })
  return {
    process: {
      stdin,
      stdout: new Readable({ read: () => {} }),
      stderr: new Readable({ read: () => {} }),
      done: Promise.withResolvers<unknown>().promise,
      terminate: () => {},
    },
    writes,
  }
}

/** Wait for the stream feed to reach the client. */
const queue = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** The `initialize` params one client sent, read back off its stdin. */
async function initializeParams(protocolVersion: number | undefined): Promise<{ protocolVersion: number; clientCapabilities: unknown }> {
  const fake = fakeProcess()
  const client = protocolVersion === undefined
    ? new AcpClient(fake.process)
    : new AcpClient(fake.process, { protocolVersion, label: 'test-engine' })
  const pending = client.initialize()
  await queue()
  const sent = JSON.parse(fake.writes[0]!) as { method: string; params: { protocolVersion: number; clientCapabilities: unknown } }
  expect(sent.method).toBe('initialize')
  // Settle the promise so the client is not left with a pending request.
  fake.process.stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`)
  await pending
  return sent.params
}

describe('the ACP protocol version is declared by the registry', () => {
  it('defaults to the documented version when a caller pins none', async () => {
    // `new AcpClient(process)` keeps meaning "kimi, version 1": every existing
    // caller and test constructs it that way.
    const params = await initializeParams(undefined)
    expect(params.protocolVersion).toBe(DEFAULT_ACP_PROTOCOL_VERSION)
    expect(params.protocolVersion).toBe(1)
    // The capability block stays EMPTY on purpose: this driver implements no
    // filesystem and no terminal reverse-RPC, so claiming either would invite a
    // call it answers with `methodNotFound`.
    expect(params.clientCapabilities).toEqual({})
  })

  it('sends whatever version its caller passes, so it cannot be a constant', async () => {
    const params = await initializeParams(7)
    expect(params.protocolVersion).toBe(7)
  })

  it('reads the declaration through the ONE accessor, on the declared row', () => {
    expect(acpProtocolVersionOf('kimi')).toBe(1)
    expect(acpProtocolVersionOf('grok')).toBe(1)
    expect(acpProtocolVersionOf('minimaxcode')).toBe(1)
    // An engine that declares nothing gets the default rather than `undefined`
    // (which would be sent as an absent field, i.e. a different handshake).
    const undeclared = HOSTED_ENGINE_IDS.filter(
      (engine: HostedEngineId) => ENGINE_REGISTRY[engine].capabilities.acpProtocolVersion === undefined)
    expect(undeclared.length).toBeGreaterThan(0)
    for (const engine of undeclared) expect(acpProtocolVersionOf(engine)).toBe(DEFAULT_ACP_PROTOCOL_VERSION)
  })

  it('gives every ACP engine a profile that announces its registry row', () => {
    const profiles = {
      kimi: kimiProfile('/no/such/kimi'),
      grok: grokProfile('/no/such/grok'),
      minimaxcode: minimaxcodeProfile('/no/such/mcode'),
    } as const
    for (const [engine, profile] of Object.entries(profiles)) {
      expect(profile.engine, engine).toBe(engine)
      expect(profile.protocolVersion, engine).toBe(acpProtocolVersionOf(engine as HostedEngineId))
      expect(ENGINE_REGISTRY[engine as HostedEngineId].capabilities.protocol, engine).toBe('acp')
    }
  })

  it('leaves no hardcoded protocol version in the shared client', async () => {
    // The mutation this guards is silent: putting the constant back would keep
    // every current engine working (they all speak version 1) while making the
    // registry declaration decorative.
    const text = await readFile(new URL('../../src/driver-acp/client.ts', import.meta.url), 'utf8')
    expect(text).not.toMatch(/protocolVersion:\s*1(?:\.0)?\b/)
    expect(text).toContain('protocolVersion: this.protocolVersion')
  })

  it('names an ACP engine for every engine that declares an ACP protocol version', () => {
    // The two halves of one promise: a row may only declare `acpProtocolVersion`
    // if it really speaks ACP, and the settings page hides engine controls from
    // the declaration.
    for (const descriptor of ENGINE_DESCRIPTORS) {
      if (descriptor.capabilities.acpProtocolVersion === undefined) continue
      expect(descriptor.capabilities.protocol, descriptor.id).toBe('acp')
    }
  })
})
