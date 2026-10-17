#!/usr/bin/env node
/**
 * ACP handshake probe: dump every frame of a real `initialize` → `session/new`
 * → `session/prompt` conversation against one engine's ACP server.
 *
 * The plugin's rule is PROBE FIRST, and for an ACP engine the thing that must be
 * READ rather than guessed is the DIALECT: which `authMethods` the agent
 * advertises, whether `session/new` accepts the params the driver sends, how a
 * model is selected (`session/set_model` vs `session/set_config_option`), and
 * whether a plain prompt answers. This script records all of it verbatim, so the
 * driver is written against frames instead of against a specification the
 * vendor may implement differently.
 *
 * It is dependency-free and imports no plugin code on purpose: a probe describes
 * the ENGINE, not what the driver already believes.
 *
 * ## Usage
 *
 * ```sh
 * node scripts/probe/acp-handshake.mjs --bin mcode --argv acp --out ../../output/probes
 * node scripts/probe/acp-handshake.mjs --bin grok  --argv agent,stdio --out ../../output/probes
 * node scripts/probe/acp-handshake.mjs --bin grok --argv agent,--always-approve,stdio --prompt "say PONG"
 * ```
 *
 * Options:
 *   --bin <path>       executable (name on PATH, or an absolute path)
 *   --argv a,b,c       argv after the executable
 *   --id <name>        label used for the report/raw files (default: the bin name)
 *   --cwd <path>       session working directory (default: this repo's root)
 *   --prompt <text>    prompt to send (default: "Reply with exactly: PONG")
 *   --out <dir>        where `<id>.acp.md` / `<id>.acp.raw.txt` land
 *   --timeout <ms>     per-request wait (default 45000)
 *   --no-prompt        stop after session/new (a login-less agent still answers
 *                      initialize + session/new, so this is the useful mode when
 *                      the account is not signed in)
 *   --set-model <id>   also try `session/set_model` and record the answer
 *   --config <configId=value>
 *                      try `session/set_config_option` with a BARE value (the
 *                      second-generation ACP spelling); repeatable
 *   --config-object <configId=value>
 *                      the same call with the `{ value }` wrapper (the spelling
 *                      Grok documents), for telling the two apart
 *   --set-mode <id>    try `session/set_mode` (the ACP mode/permission switch)
 *   --authenticate <methodId>
 *                      call `authenticate` with this method id after
 *                      `initialize` (send an obviously invalid id to learn
 *                      whether the METHOD exists without starting a real
 *                      sign-in)
 *   --load             after the prompt, try `session/load` on the same session
 *                      id, which is what "resume a session by id" means in ACP
 *
 * @module scripts/probe/acp-handshake
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Parse `--flag value` / `--flag` into a map; a repeated flag accumulates into an
 * array, which is what lets `--config a=1 --config b=2` probe several options.
 */
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const key = token.slice(2)
    const next = argv[i + 1]
    const value = next === undefined || next.startsWith('--') ? true : next
    if (value !== true) i += 1
    const prior = out[key]
    out[key] = prior === undefined ? value : [...(Array.isArray(prior) ? prior : [prior]), value]
  }
  return out
}

/** One flag's values as an array, whether it was given once, repeatedly, or not at all. */
function values(key) {
  const raw = args[key]
  if (raw === undefined || raw === true) return []
  return Array.isArray(raw) ? raw : [raw]
}

const args = parseArgs(process.argv.slice(2))
if (typeof args.bin !== 'string') {
  process.stderr.write('usage: node scripts/probe/acp-handshake.mjs --bin <exe> [--argv a,b,c] [--out dir]\n')
  process.exit(2)
}

const bin = args.bin
const engineId = typeof args.id === 'string' ? args.id : bin.replace(/\.exe$/i, '')
const childArgv = typeof args.argv === 'string' && args.argv !== '' ? args.argv.split(',') : []
const cwd = typeof args.cwd === 'string' ? resolve(args.cwd) : resolve(HERE, '..', '..')
const prompt = typeof args.prompt === 'string' ? args.prompt : 'Reply with exactly: PONG'
const timeoutMs = typeof args.timeout === 'string' ? Number(args.timeout) : 45000
const sendPrompt = args['no-prompt'] !== true
const outDir = resolve(typeof args.out === 'string' ? args.out : join(HERE, '..', '..', 'output', 'probes'))

/** One JSON-RPC line, exactly as it went on the wire. */
const log = []
/** Frame counters for the summary. */
const seen = { updates: new Set(), reverse: new Set(), errors: [] }

function stamp() { return new Date().toISOString().slice(11, 23) }

function note(direction, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  log.push(`${stamp()} ${direction} ${text}`)
}

mkdirSync(outDir, { recursive: true })

const resolved = existsSync(bin) ? bin : undefined
note('#spawn', `${bin} ${childArgv.join(' ')}`)
note('#info', `resolved=${resolved ?? 'via PATH'} cwd=${cwd}`)

const child = spawn(bin, childArgv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })

let buffer = ''
let sealed = false
/** Set when the executable could not be spawned at all (ENOENT, EINVAL, …). */
let spawnError
/** The child's exit code, once it closes. */
let exitCode
const pending = new Map()
let nextId = 1
const results = {}

function send(method, params) {
  const id = nextId++
  const frame = { jsonrpc: '2.0', id, method, params }
  note('-->', frame)
  child.stdin.write(`${JSON.stringify(frame)}\n`)
  return new Promise((settle) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      settle({ timedOut: true })
    }, timeoutMs)
    pending.set(id, (value) => { clearTimeout(timer); settle(value) })
  })
}

/** Answer a reverse-RPC request the way the driver's permission policy would. */
function answerReverse(frame) {
  const options = Array.isArray(frame.params?.options) ? frame.params.options : []
  const allow = options.find(option => option?.kind === 'allow_once') ?? options.find(option => option?.kind === 'allow_always')
  const result = allow === undefined
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId: allow.optionId } }
  note('<--', { jsonrpc: '2.0', id: frame.id, result, note: 'auto-answer: first allow_once' })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`)
  return result
}

function dispatch(line) {
  let frame
  try { frame = JSON.parse(line) } catch { note('#nonjson', line); return }
  note('<--', frame)
  if (typeof frame.method === 'string' && typeof frame.id === 'number') {
    seen.reverse.add(frame.method)
    if (frame.method === 'session/request_permission') { answerReverse(frame); return }
    // Unknown reverse-RPC: answer methodNotFound so the agent never hangs.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } })}\n`)
    return
  }
  if (frame.method === 'session/update') {
    const kind = frame.params?.update?.sessionUpdate
    if (typeof kind === 'string') seen.updates.add(kind)
    return
  }
  if (typeof frame.id === 'number') {
    const settle = pending.get(frame.id)
    if (settle !== undefined) { pending.delete(frame.id); settle(frame) }
    if (frame.error !== undefined) seen.errors.push(frame.error.message ?? 'error')
  }
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) break
    let line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.trim() !== '') dispatch(line)
  }
})
const stderrChunks = []
child.stderr.on('data', (chunk) => {
  stderrChunks.push(chunk.toString('utf8'))
  if (stderrChunks.length <= 40) note('#stderr', chunk.toString('utf8').trimEnd())
})
child.on('error', (error) => {
  // Kept as a first-class result, not just a log line: when the executable does
  // not exist every request times out and the report would otherwise say
  // "error: (none)" beside an empty frame log — which reads like an engine that
  // refused, rather than a probe that never started.
  spawnError = String(error)
  note('#error', spawnError)
  sealed = true
})
child.on('close', (code) => { note('#exit', String(code)); exitCode = code; sealed = true })

/** Wait for the child's exit, bounded. */
async function settleChild(ms) {
  const started = Date.now()
  while (!sealed && Date.now() - started < ms) await new Promise(r => setTimeout(r, 100))
  if (!sealed) { note('#kill', 'probe timeout: terminating child'); child.kill() }
}

try {
  results.initialize = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'dsh-loop-engine-probe', version: '1.0.0' },
  })
  results.newSession = await send('session/new', { cwd, mcpServers: [] })
  if (typeof args.authenticate === 'string') {
    results.authenticate = await send('authenticate', { methodId: args.authenticate })
    // A second attempt records whether authenticating unblocked session/new.
    results.newSessionAfterAuth = await send('session/new', { cwd, mcpServers: [] })
  }
  const sessionId = results.newSession?.result?.sessionId
  if (typeof sessionId !== 'string') {
    note('#stop', 'session/new returned no session id — stopping before prompt')
  } else {
    if (typeof args['set-model'] === 'string') {
      results.setModel = await send('session/set_model', { sessionId, modelId: args['set-model'] })
    }
    // The two `session/set_config_option` spellings are probed separately: ACP's
    // documented form wraps the value (`{ value }`), while at least one agent's
    // schema takes a BARE string/boolean. Which one an engine accepts is a
    // field-level dialect difference the driver has to know.
    results.configBare = []
    for (const entry of values('config')) {
      const [configId, value] = entry.split('=')
      results.configBare.push({ entry, frame: await send('session/set_config_option', { sessionId, configId, value }) })
    }
    results.configObject = []
    for (const entry of values('config-object')) {
      const [configId, value] = entry.split('=')
      results.configObject.push({ entry, frame: await send('session/set_config_option', { sessionId, configId, value: { value } }) })
    }
    results.setMode = []
    for (const modeId of values('set-mode')) {
      results.setMode.push({ modeId, frame: await send('session/set_mode', { sessionId, modeId }) })
    }
    if (sendPrompt) {
      results.prompt = await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
    }
    if (args.load === true) {
      results.load = await send('session/load', { sessionId, cwd, mcpServers: [] })
    }
  }
} catch (error) {
  note('#throw', String(error))
} finally {
  await settleChild(3000)
  child.stdin.end()
  try { child.kill() } catch { /* already gone */ }
}

const initializeResult = results.initialize?.result ?? {}
const authMethods = Array.isArray(initializeResult.authMethods)
  ? initializeResult.authMethods.map(m => `${m?.id ?? '?'}${m?.name === undefined ? '' : ` (${m.name})`}`)
  : []
const promptResult = results.prompt?.result ?? results.prompt
const report = [
  `## ${engineId} — ACP handshake`,
  '',
  `- executable: \`${bin}\`${resolved === undefined ? ' (resolved via PATH)' : ''}`,
  `- spawn argv: \`${[bin, ...childArgv].join(' ')}\``,
  `- cwd: \`${cwd}\``,
  `- host: ${process.platform} ${process.arch}, node ${process.version}`,
  '',
  '### spawn',
  '',
  `- spawn error: ${spawnError === undefined ? '(none)' : spawnError}`,
  `- exit code: ${exitCode === undefined ? '(still running at report time)' : String(exitCode)}`,
  '',
  '### initialize',
  '',
  `- protocolVersion (client → agent): 1`,
  `- agent protocolVersion: \`${String(initializeResult.protocolVersion ?? '(absent)')}\``,
  `- authMethods: ${authMethods.length === 0 ? '(none advertised)' : authMethods.join(', ')}`,
  `- agentCapabilities: \`${JSON.stringify(initializeResult.agentCapabilities ?? {})}\``,
  `- agentInfo: \`${JSON.stringify(initializeResult.agentInfo ?? {})}\``,
  `- error: ${results.initialize?.error === undefined ? '(none)' : JSON.stringify(results.initialize.error)}`,
  '',
  '### session/new',
  '',
  `- params sent: \`{"cwd":"…","mcpServers":[]}\``,
  `- result keys: \`${JSON.stringify(Object.keys(results.newSession?.result ?? {}))}\``,
  `- sessionId: \`${String(results.newSession?.result?.sessionId ?? '(absent)')}\``,
  `- configOptions: \`${JSON.stringify(results.newSession?.result?.configOptions ?? null)}\``,
  `- error: ${results.newSession?.error === undefined ? '(none)' : JSON.stringify(results.newSession.error)}`,
  ...(results.authenticate === undefined ? [] : [
    '',
    '### authenticate',
    '',
    `- \`authenticate\`: ${results.authenticate?.error === undefined ? 'ACCEPTED' : `REJECTED — ${JSON.stringify(results.authenticate.error)}`}`,
    `- \`session/new\` after it: ${results.newSessionAfterAuth?.error === undefined ? `ACCEPTED (sessionId ${String(results.newSessionAfterAuth?.result?.sessionId)})` : `REJECTED — ${JSON.stringify(results.newSessionAfterAuth.error)}`}`,
  ]),
  '',
  '### model selection',
  '',
  results.setModel === undefined
    ? '- `session/set_model`: not attempted (pass --set-model <id>)'
    : `- \`session/set_model\`: ${results.setModel?.error === undefined ? 'ACCEPTED' : `REJECTED — ${JSON.stringify(results.setModel.error)}`}`,
  ...(results.configBare ?? []).map(entry =>
    `- \`session/set_config_option\` bare \`${entry.entry}\`: ${entry.frame?.error === undefined ? 'ACCEPTED' : `REJECTED — ${JSON.stringify(entry.frame.error)}`}`),
  ...(results.configObject ?? []).map(entry =>
    `- \`session/set_config_option\` object \`${entry.entry}\`: ${entry.frame?.error === undefined ? 'ACCEPTED' : `REJECTED — ${JSON.stringify(entry.frame.error)}`}`),
  ...(results.setMode ?? []).map(entry =>
    `- \`session/set_mode\` \`${entry.modeId}\`: ${entry.frame?.error === undefined ? 'ACCEPTED' : `REJECTED — ${JSON.stringify(entry.frame.error)}`}`),
  '',
  '### session/prompt',
  '',
  sendPrompt
    ? `- responded: ${results.prompt === undefined ? 'no' : (results.prompt.timedOut === true ? 'TIMED OUT' : 'yes')}`
    : '- not attempted (--no-prompt)',
  sendPrompt ? `- stopReason: \`${String(promptResult?.stopReason ?? '(absent)')}\`` : '',
  sendPrompt && results.prompt?.error !== undefined ? `- error: ${JSON.stringify(results.prompt.error)}` : '',
  '',
  '### session/load (resume by id)',
  '',
  results.load === undefined
    ? '- not attempted (pass --load)'
    : `- \`session/load\`: ${results.load?.error === undefined ? 'ACCEPTED' : `REJECTED — ${JSON.stringify(results.load.error)}`}`,
  '',
  '### session/update kinds seen',
  '',
  seen.updates.size === 0 ? '(none)' : [...seen.updates].map(kind => `- \`${kind}\``).join('\n'),
  '',
  '### reverse-RPC methods the agent called',
  '',
  seen.reverse.size === 0 ? '(none)' : [...seen.reverse].map(method => `- \`${method}\``).join('\n'),
  '',
  '### raw frames',
  '',
  `- \`${engineId}.acp.raw.txt\` (every frame, both directions, timestamped)`,
  '',
  '```',
  log.join('\n').slice(0, 6000),
  '```',
  '',
].join('\n')

writeFileSync(join(outDir, `${engineId}.acp.md`), report)
writeFileSync(join(outDir, `${engineId}.acp.raw.txt`), log.join('\n'))
process.stdout.write(`${engineId}: spawn=${spawnError === undefined ? 'ok' : 'FAILED'} initialize=${results.initialize?.timedOut === true ? 'TIMED OUT' : results.initialize?.error === undefined ? 'ok' : 'error'}`
  + ` authMethods=${authMethods.length} session/new=${results.newSession?.result?.sessionId === undefined ? 'no-id' : 'ok'}`
  + ` prompt=${sendPrompt ? (results.prompt?.result !== undefined ? 'answered' : 'no') : 'skipped'}`
  + ` updates=${[...seen.updates].join('|')}\n`)
