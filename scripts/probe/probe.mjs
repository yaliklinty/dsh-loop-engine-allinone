#!/usr/bin/env node
/**
 * Protocol probe for every external CLI the plugin knows about.
 *
 * The plugin's rule is PROBE FIRST: an engine's wire protocol is recorded from
 * real frames before a driver is written for it, because a guessed frame shape
 * produces a driver that looks finished and silently answers nothing. This script
 * is that record, and it is re-runnable — a CLI updates, or a host signs in, and
 * the report is regenerated rather than remembered.
 *
 * It is deliberately dependency-free and reads only through the public CLI
 * surface: no plugin code is imported, so a probe describes the ENGINE rather
 * than describing what the driver already believes.
 *
 * ## Usage
 *
 * ```sh
 * node scripts/probe/probe.mjs                 # every engine
 * node scripts/probe/probe.mjs agy qoderclicn  # named engines only
 * node scripts/probe/probe.mjs --out D:/dir    # where raw captures land
 * ```
 *
 * ## What it captures, and what it refuses to guess
 *
 * For each engine: whether the executable resolves, its `--version` output, its
 * `--help` output (the surface the driver may use), and one real prompt whose raw
 * stdout/stderr is dumped verbatim. A probe NEVER invents a protocol: when the
 * engine cannot run (absent, not signed in, subscription lapsed) the report says
 * so and leaves the wire shape UNKNOWN, which is the honest state a driver must
 * be written against.
 *
 * @module scripts/probe
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Run one child to completion, capturing both streams and the exit code. */
function run(argv, { stdin = undefined, timeoutMs = 60000, cwd = process.cwd(), env = undefined } = {}) {
  return new Promise((settle) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Layered over the ambient environment, never replacing it: an engine
      // inherits its own state directory (HERMES_HOME, KIMI_CODE_HOME, …) that
      // way, and a probe that replaced the environment would report a fresh
      // install instead of the user's own.
      ...env === undefined ? {} : { env: { ...process.env, ...env } },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ ok: false, stdout, stderr: `${stderr}${String(error)}`, exitCode: null, timedOut, spawnError: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ ok: code === 0, stdout, stderr, exitCode: code, timedOut })
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

const HOME = homedir()
const LOCAL = process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local')

/**
 * The engine catalogue this probe knows how to look for.
 *
 * `argv` is the probe invocation, and `stdin`, when present, is the payload an
 * engine that reads its prompt from its input channel needs. Each entry names the
 * paths worth probing before falling back to PATH, because a desktop-launched
 * deployment does not always inherit the PATH entry an installer added.
 */
const ENGINES = {
  agy: {
    paths: [join(LOCAL, 'agy', 'bin', 'agy.EXE'), join(LOCAL, 'agy', 'bin', 'agy')],
    pathName: 'agy',
    authPaths: [join(HOME, '.gemini', 'oauth_creds.json')],
    argv: (bin) => [bin, '--input-format', 'stream-json', '--output-format', 'stream-json', '--print='],
    // The prompt travels as one NDJSON line on stdin. `--print=` carries an
    // EMPTY value on purpose: left bare, the flag eats the next argv element
    // (`--input-format`) as its prompt and the real prompt is ignored.
    //
    // The line needs an `event` discriminator; without it the CLI answers
    // `error: stream input message is missing the "event" field`.
    stdin: (prompt) => `${JSON.stringify({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    })}\n`,
    versionArgv: (bin) => [bin, '--version'],
  },
  zcode: {
    paths: ['D:\\Programs\\ZCode\\resources\\glm\\zcode.cjs', join(LOCAL, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs')],
    pathName: 'zcode',
    authPaths: [join(HOME, '.zcode', 'v2'), join(HOME, '.zcode', 'cli')],
    // A Node bundle, so it runs under the current node rather than directly.
    argv: (bin) => (/\.(?:c|m)?js$/i.test(bin) ? [process.execPath, bin] : [bin]).concat(['-p', 'Reply with exactly: PONG', '--no-color']),
    env: {
      // Run outside the desktop app, the bundle cannot find its own provider
      // catalogue and refuses to start a turn without this.
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'D:\\Programs\\ZCode\\resources\\config\\provider\\zcode-builtin.json',
    },
    versionArgv: (bin) => (/\.(?:c|m)?js$/i.test(bin) ? [process.execPath, bin] : [bin]).concat(['version']),
  },
  qoderclicn: {
    paths: [join(HOME, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn.exe'), join(HOME, '.qoder-cn', 'bin', 'qoderclicn', 'qoderclicn')],
    pathName: 'qoderclicn',
    authPaths: [join(HOME, '.qoder-cn', '.auth', 'user')],
    argv: (bin) => [bin, '-p', '--output-format', 'stream-json', 'Reply with exactly: PONG'],
    versionArgv: (bin) => [bin, '--version'],
  },
  hermes: {
    paths: [join(LOCAL, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'), join(LOCAL, 'hermes', 'bin', 'hermes.exe')],
    pathName: 'hermes',
    authPaths: [join(process.env.HERMES_HOME ?? join('D:', 'HermesData', 'hermes-home'), 'auth.json')],
    argv: (bin) => [bin, '-z', 'Reply with exactly: PONG'],
    versionArgv: (bin) => [bin, '--version'],
  },
  // P2: probe-only. Neither is installed on the reference host, so the probe
  // records HOW TO LOOK rather than a protocol — which is the whole point of
  // listing them: the moment one is installed, the same command produces a real
  // report.
  grok: {
    paths: [join(HOME, '.grok', 'bin', 'grok.exe'), join(LOCAL, 'grok', 'bin', 'grok.exe')],
    pathName: 'grok',
    authPaths: [join(HOME, '.grok', 'auth.json'), join(HOME, '.config', 'grok', 'auth.json')],
    argv: (bin) => [bin, '--help'],
    versionArgv: (bin) => [bin, '--version'],
    probeOnly: true,
  },
  minimaxcode: {
    paths: [join(HOME, '.minimax', 'bin', 'minimax-code.exe'), join(HOME, '.minimax', 'bin', 'minimax.exe')],
    pathName: 'minimax-code',
    authPaths: [join(HOME, '.minimax', 'auth.json')],
    argv: (bin) => [bin, '--help'],
    versionArgv: (bin) => [bin, '--version'],
    probeOnly: true,
  },
}

/**
 * The argv prefix that launches an engine.
 *
 * A `.cjs`/`.mjs` bundle is run under the current node (spawning it directly
 * fails with EFTYPE on Windows); a native binary is launched as itself.
 * @param bin - the resolved executable or script.
 * @returns the argv prefix ending in the entrypoint.
 */
function prefixOf(bin) {
  return /\.(?:c|m)?js$/i.test(bin) ? [process.execPath, bin] : [bin]
}

/** Resolve an engine's executable: a known install path first, then PATH. */
function resolveBinary(spec) {
  for (const candidate of spec.paths) {
    if (existsSync(candidate)) return { bin: candidate, how: 'known-path' }
  }
  return { bin: spec.pathName, how: 'PATH' }
}

/** One engine's probe. */
async function probe(id, outDir) {
  const spec = ENGINES[id]
  const { bin, how } = resolveBinary(spec)
  const auth = (spec.authPaths ?? []).map(path => ({ path, present: existsSync(path) }))
  const lines = [`## ${id}`, '', `- executable: \`${bin}\` (resolved via ${how})`]
  for (const entry of auth) lines.push(`- auth path: \`${entry.path}\` → ${entry.present ? 'present' : 'MISSING'}`)
  lines.push('')

  const prefix = prefixOf(bin)
  const version = await run(spec.versionArgv(bin), { timeoutMs: 30000, env: spec.env })
  lines.push(`### version`, '', '```', (version.stdout + version.stderr).trim().slice(0, 500), '```', '')

  const help = await run([...prefix, '--help'], { timeoutMs: 30000, env: spec.env })
  lines.push(`### --help`, '', '```', (help.stdout + help.stderr).trim().slice(0, 4000), '```', '')

  if (spec.probeOnly) {
    lines.push(
      '### protocol',
      '',
      '**UNKNOWN — not installed on the probe host.** This entry is a discovery record:',
      'the lookup paths and the probe invocation above are the reproducible part, so',
      'running this command on a host that has the CLI produces the real frames.',
      '',
      'Driver status: none. The registry row exists (so the engine is visible and its',
      'requirements are declared) and the driver table deliberately has no factory.',
      '',
    )
    writeFileSync(join(outDir, `${id}.raw.txt`), `${version.stdout}${version.stderr}`)
    writeFileSync(join(outDir, `${id}.md`), lines.join('\n'))
    return { id, ran: false, reason: 'not installed (probe-only entry)' }
  }

  const spec_ = spec
  const argv = spec_.argv(bin)
  const stdin = spec_.stdin?.('Reply with exactly: PONG')
  const prompt = await run(argv, { stdin, timeoutMs: 90000, env: spec_.env })
  const rawName = `${id}.raw.txt`
  writeFileSync(join(outDir, rawName), [
    `$ ${argv.join(' ')}`,
    stdin === undefined ? '' : `# stdin:\n${stdin}`,
    `# exit code: ${prompt.exitCode}${prompt.timedOut ? ' (TIMED OUT)' : ''}`,
    '', '# ---- stdout ----', prompt.stdout,
    '', '# ---- stderr ----', prompt.stderr,
  ].join('\n'))
  const frameCount = prompt.stdout.split('\n').filter(line => line.trim() !== '').length
  lines.push(
    '### one real prompt', '',
    `- exit code: \`${prompt.exitCode}\`${prompt.timedOut ? ' (TIMED OUT)' : ''}`,
    `- stdout: ${prompt.stdout.length} bytes over ${frameCount} non-blank line(s)`,
    `- stderr: ${prompt.stderr.trim() === '' ? '(empty)' : '```\n' + prompt.stderr.trim().slice(0, 2000) + '\n```'}`,
    `- raw capture: \`${rawName}\``, '',
    '```', prompt.stdout.trim().slice(0, 4000), '```', '',
  )
  writeFileSync(join(outDir, `${id}.md`), lines.join('\n'))
  return {
    id,
    ran: true,
    exitCode: prompt.exitCode,
    lines: frameCount,
    answered: /PONG/.test(prompt.stdout),
    reason: prompt.timedOut ? 'timed out' : (prompt.stderr.trim().split('\n')[0] ?? ''),
  }
}

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outDir = resolve(outIndex === -1 ? 'output/probes' : argv[outIndex + 1] ?? 'output/probes')
const names = argv.filter((value, index) => !value.startsWith('--') && index !== outIndex + 1)
const targets = names.length > 0 ? names : Object.keys(ENGINES)

mkdirSync(outDir, { recursive: true })
const results = []
for (const id of targets) {
  if (ENGINES[id] === undefined) {
    results.push({ id, ran: false, reason: 'unknown engine id' })
    continue
  }
  process.stdout.write(`probing ${id}… `)
  // Sequential on purpose: these CLIs spawn their own helpers and share session
  // stores, so probing them concurrently can make one another's output.
  results.push(await probe(id, outDir))
  process.stdout.write('done\n')
}

writeFileSync(join(outDir, 'SUMMARY.md'), [
  '# Protocol probe summary',
  '',
  `Host: ${process.platform} ${process.arch}, node ${process.version}`,
  `Output directory: \`${outDir}\``,
  '',
  '| engine | ran | exit | frames | answered PONG | note |',
  '|---|---|---|---|---|---|',
  ...results.map(r => `| ${r.id} | ${r.ran ? 'yes' : 'no'} | ${r.exitCode ?? '—'} | ${r.lines ?? '—'} | ${r.answered === undefined ? '—' : String(r.answered)} | ${r.reason ?? ''} |`),
  '',
  'An engine that did not answer `PONG` did not necessarily fail: it may be',
  'unsigned, unsubscribed, or refusing the probe prompt. What matters is that the',
  'raw capture exists, so the wire shape is read rather than assumed.',
  '',
].join('\n'))

console.log('\n' + results.map(r => `${r.id}: ${r.ran ? `exit ${r.exitCode}, ${r.lines} line(s)` : `skipped — ${r.reason}`}`).join('\n'))
