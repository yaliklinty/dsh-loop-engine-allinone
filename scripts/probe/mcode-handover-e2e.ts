/**
 * E2E probe: hand a mock dsh endpoint to the REAL `mcode acp` child through the
 * plugin's own handover document, then run one ACP turn and print the text.
 */
import { AcpClient } from '../../src/driver-acp/client.ts'
import { chunkDelta, isTextChunk, isThoughtChunk } from '../../src/driver-acp/mapping.ts'
import { minimaxcodeProfile } from '../../src/engine-minimaxcode/profile.ts'
import { mcodeBinResolver } from '../../src/engine-minimaxcode/process.ts'
import { mcodeHandoverEnv } from '../../src/engine-minimaxcode/model-handover.ts'
import type { Session } from '@deepseek-ai/dsh-session'

const port = process.argv[2] ?? '18999'
const handover = {
  provider: 'mock',
  model: 'mock-model',
  baseURL: `http://127.0.0.1:${port}/v1`,
  api: 'openai-completions',
  apiKey: 'sk-mock',
  contextWindow: 128000,
  maxOutputTokens: 4096,
}
const bin = mcodeBinResolver()
const profile = minimaxcodeProfile(bin)
const session = { snapshotEvents: () => [] } as unknown as Session
const env = { ...process.env, ...mcodeHandoverEnv(handover) } as Record<string, string>
process.stdout.write(`[mcode-e2e] argv: ${profile.argv(bin).join(' ')}\n`)
process.stdout.write(`[mcode-e2e] MINIMAX_DATA_DIR: ${env.MINIMAX_DATA_DIR}\n`)

const client = AcpClient.create(
  { argv: profile.argv(bin), cwd: process.cwd(), env },
  undefined,
  { protocolVersion: profile.protocolVersion, label: profile.label },
)
const texts: string[] = []
client.onUpdate((update) => {
  if (isTextChunk(update)) texts.push(chunkDelta(update))
  else if (isThoughtChunk(update)) texts.push(`[thought] ${chunkDelta(update)}`)
})
client.onPermission(() => false)

const timeout = setTimeout(() => {
  process.stderr.write('[mcode-e2e] TIMED OUT\n')
  client.dispose()
  process.exit(1)
}, 120_000)

try {
  const initialized = await client.initialize()
  const sessionId = await profile.openSession!(client, process.cwd(), session, initialized)
  process.stdout.write(`[mcode-e2e] session/new: ${sessionId}\n`)
  const result = await client.prompt(sessionId, 'Reply with exactly: PONG') as { stopReason?: string }
  process.stdout.write(`[mcode-e2e] stopReason: ${String(result?.stopReason)}\n`)
  process.stdout.write(`[mcode-e2e] text: ${texts.join('')}\n`)
} finally {
  clearTimeout(timeout)
  client.dispose()
}
