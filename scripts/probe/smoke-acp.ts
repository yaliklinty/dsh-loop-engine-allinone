#!/usr/bin/env node
/**
 * End-to-end smoke test for one ACP engine's DRIVER path.
 *
 * `scripts/probe/acp-handshake.mjs` records what the CLI emits; this records what
 * the DRIVER's own code does with it. It uses the real `AcpClient` and the
 * engine's real profile (the same objects the plugin builds in a session):
 *
 *   initialize → the profile's `openSession` → the profile's `selectModel` →
 *   `session/prompt`, with every `session/update` running through the driver's
 *   own mapper (`driver-acp/mapping.ts`) and the reverse-RPC permission requests
 *   answered by the profile's approval fold.
 *
 * It deliberately does NOT go through the dsh subprocess seam or a Cordis
 * context: it is a protocol + dialect check, not a lifecycle check. The lifecycle
 * is covered by the unit specs and by a real profile mount.
 *
 * ```sh
 * node node_modules/tsx/dist/cli.mjs scripts/probe/smoke-acp.ts minimaxcode
 * node node_modules/tsx/dist/cli.mjs scripts/probe/smoke-acp.ts minimaxcode "m:minimax:MiniMax-M3:v:thinking"
 * node node_modules/tsx/dist/cli.mjs scripts/probe/smoke-acp.ts grok --bin "D:/x/node_modules/@xai-official/grok/bin/grok"
 * ```
 *
 * @module scripts/probe/smoke-acp
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { AcpClient } from '../../src/driver-acp/client.ts'
import {
  chunkDelta,
  isTextChunk,
  isThoughtChunk,
  isToolCall,
  isToolCallUpdate,
} from '../../src/driver-acp/mapping.ts'
import type { AcpEngineProfile } from '../../src/driver-acp/profile.ts'
import type { AcpUpdate } from '../../src/driver-acp/types.ts'
import { grokProfile } from '../../src/engine-grok/profile.ts'
import { grokBinResolver } from '../../src/engine-grok/process.ts'
import { minimaxcodeProfile } from '../../src/engine-minimaxcode/profile.ts'
import { mcodeBinResolver } from '../../src/engine-minimaxcode/process.ts'
import { kimiProfile } from '../../src/engine-kimi/profile.ts'
import { kimiBinResolver } from '../../src/engine-kimi/process.ts'

const PROMPT = 'Reply with exactly: PONG'

/** A session whose durable knobs are empty: the smoke test is not about approval policy. */
const session = { snapshotEvents: () => [] } as unknown as Session

/** The three ACP engines the driver knows, each with its own profile and resolver. */
const ENGINES: Record<string, { profile: (bin: string) => AcpEngineProfile; bin: () => string }> = {
  minimaxcode: { profile: minimaxcodeProfile, bin: () => mcodeBinResolver() },
  grok: { profile: grokProfile, bin: () => grokBinResolver() },
  kimi: { profile: kimiProfile, bin: () => kimiBinResolver() },
}

const argv = process.argv.slice(2)
const binFlag = argv.indexOf('--bin')
const explicitBin = binFlag === -1 ? undefined : argv[binFlag + 1]
// The flag's VALUE must be skipped, not "index !== binFlag + 1": with no `--bin`
// at all `binFlag` is -1, so that expression skipped index 0 — the engine name —
// and `smoke-acp.ts grok` silently ran minimaxcode instead. Skipping only when
// the flag is actually present keeps the positional list honest.
const binValueIndex = binFlag === -1 ? -1 : binFlag + 1
const positional = argv.filter((value, index) =>
  !value.startsWith('--') && index !== binValueIndex)
const target = positional[0] ?? 'minimaxcode'
const pickedModel = positional[1]

const engine = ENGINES[target]
if (engine === undefined) {
  process.stderr.write(`unknown engine "${target}" — expected one of ${Object.keys(ENGINES).join(', ')}\n`)
  process.exit(2)
}

const bin = explicitBin ?? engine.bin()
const profile = engine.profile(bin)
const spec = {
  argv: profile.argv(bin),
  cwd: process.cwd(),
  // The real environment, so the CLI finds its own credentials: this smoke test
  // exercises the engine's dialect, not the credential scrubbing the dsh
  // subprocess seam performs.
  env: { ...process.env } as Record<string, string>,
}

process.stdout.write(`[${target}] argv: ${spec.argv.join(' ')}\n`)
process.stdout.write(`[${target}] protocolVersion: ${profile.protocolVersion} (registry-declared), images: ${profile.images}\n`)

const client = AcpClient.create(spec, undefined, { protocolVersion: profile.protocolVersion, label: profile.label })
const text: string[] = []
const thoughts: string[] = []
const tools: string[] = []
client.onUpdate((update: AcpUpdate) => {
  if (isTextChunk(update)) text.push(chunkDelta(update))
  else if (isThoughtChunk(update)) thoughts.push(chunkDelta(update))
  else if (isToolCall(update)) tools.push(`call ${String((update as { title?: unknown }).title)}`)
  else if (isToolCallUpdate(update)) tools.push(`update ${String((update as { toolCallId?: unknown }).toolCallId)}:${String((update as { status?: unknown }).status)}`)
})
// The profile's own approval fold, exactly as the plugin wires it in a session.
client.onPermission(() => (profile.approve ?? (() => false))(session))

const timeout = setTimeout(() => {
  process.stdout.write(`[${target}] TIMED OUT after 120s\n`)
  client.dispose()
  process.exit(1)
}, 120_000)

try {
  const initialized = await client.initialize() as { authMethods?: { id?: string }[]; agentInfo?: unknown }
  process.stdout.write(`[${target}] initialize: authMethods=${JSON.stringify(initialized?.authMethods?.map(method => method.id) ?? [])} agentInfo=${JSON.stringify(initialized?.agentInfo ?? {})}\n`)
  const sessionId = profile.openSession === undefined
    ? await client.newSession(spec.cwd)
    : await profile.openSession(client, spec.cwd, session, initialized)
  process.stdout.write(`[${target}] session/new: ${sessionId}\n`)
  if (pickedModel !== undefined && profile.selectModel !== undefined) {
    await profile.selectModel(client, sessionId, pickedModel)
    process.stdout.write(`[${target}] set model: ${pickedModel} (accepted)\n`)
  }
  const result = await client.prompt(sessionId, PROMPT) as { stopReason?: string }
  process.stdout.write(`[${target}] prompt: stopReason=${String(result?.stopReason)}\n`)
  process.stdout.write(`[${target}] thoughts: ${thoughts.join('').trim().slice(0, 200) || '(none)'}\n`)
  process.stdout.write(`[${target}] tool frames: ${tools.slice(0, 6).join(', ') || '(none)'}\n`)
  const answer = text.join('').trim()
  process.stdout.write(`[${target}] answer: ${answer.slice(0, 400)}\n`)
  process.stdout.write(/PONG/i.test(answer) ? `[${target}] SMOKE OK\n` : `[${target}] SMOKE: answered, but no PONG\n`)
  clearTimeout(timeout)
  client.dispose()
  process.exit(/PONG/i.test(answer) ? 0 : 1)
} catch (error: unknown) {
  clearTimeout(timeout)
  process.stdout.write(`[${target}] FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  client.dispose()
  process.exit(1)
}
