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
 * An engine that speaks ACP gets a second stage: the probe re-runs the standalone
 * `acp-handshake.mjs` prober (see {@link probeAcp}) so the same
 * `initialize` → `session/new` → `session/prompt` conversation that script records
 * by hand is also recorded here, into `<id>.acp.md` / `<id>.acp.raw.txt`. The
 * dialect questions that need extra flags — which model-selection method an agent
 * accepts, how a config value must be spelled — are asked by calling that script
 * directly, so this stage stays one fixed conversation that is comparable between
 * engines:
 *
 * ```sh
 * node scripts/probe/acp-handshake.mjs --bin <exe> --argv <a,b> --id <engine> \
 *   --set-model <id> --config model=<value> --config-object model=<value> --set-mode plan --load
 * ```
 *
 * @module scripts/probe
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This script's own directory, so the ACP stage can find its sibling prober. */
const HERE = dirname(fileURLToPath(import.meta.url))

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
 * Where a globally installed npm package actually lives.
 *
 * `npm i -g` writes the launcher shim into the prefix (`<prefix>/mcode.cmd`) and
 * the package into `<prefix>/node_modules`; the shim is not an executable Node can
 * start (see {@link launchPrefix}), so the package's own entrypoint is listed as a
 * candidate too. The prefixes come from the ENVIRONMENT, not from a literal path: a
 * probe that only finds an engine on the author's machine reports "not installed"
 * for something that is installed, which is the opposite of the honest failure this
 * script exists to produce. `%APPDATA%\npm` is npm's own Windows default and covers
 * a host that never moved its prefix.
 */
const NPM_PREFIXES = [
  // Whatever the running npm is configured with, when it can be asked cheaply.
  process.env.npm_config_prefix,
  // The common per-machine layouts, all derived.
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
  process.env.ProgramFiles,
  join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'npm'),
  join(HOME, '.npm-global'),
].filter(prefix => typeof prefix === 'string' && prefix !== '')

/** The npm package root for `@minimax-ai/code` under each known prefix. */
const MCODE_PACKAGE_DIRS = NPM_PREFIXES.map(prefix => join(prefix, 'node_modules', '@minimax-ai', 'code'))

/**
 * Every plausible root of a ZCode desktop install, derived from the environment.
 * @returns candidate install roots, most specific first.
 */
function zcodeRoots() {
  const roots = [process.env.ZCODE_HOME]
  if (process.env.LOCALAPPDATA !== undefined) roots.push(join(LOCAL, 'Programs', 'ZCode'))
  if (process.platform === 'win32' && process.env.ProgramFiles !== undefined) {
    roots.push(join(process.env.ProgramFiles, 'ZCode'))
  }
  return roots.filter(root => typeof root === 'string' && root !== '')
}

/**
 * The provider-catalog env entry for the bundle, when a catalog can be found.
 *
 * Spread into a spec's `env`, so a host with no ZCode install simply contributes no
 * entry instead of pointing the bundle at a path that does not exist.
 * @returns zero or one environment entry.
 */
function zcodeProviderConfig() {
  for (const root of zcodeRoots()) {
    const candidate = join(root, 'resources', 'config', 'provider', 'zcode-builtin.json')
    if (existsSync(candidate)) return { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: candidate }
  }
  return {}
}

/**
 * The engine catalogue this probe knows how to look for.
 *
 * `argv` is the probe invocation, and `stdin`, when present, is the payload an
 * engine that reads its prompt from its input channel needs. Each entry names the
 * paths worth probing before falling back to PATH, because a desktop-launched
 * deployment does not always inherit the PATH entry an installer added.
 *
 * `acpArgv`, when present, is the argv that starts the engine's ACP server over
 * stdio; it is what the {@link probeAcp} stage feeds to `acp-handshake.mjs`.
 * `acpArgs` adds engine-specific dialect flags to that same invocation (see the
 * minimaxcode entry), so a dialect question that needs an extra request is asked
 * inside the artifact rather than left to prose.
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
    paths: zcodeRoots().map(root => join(root, 'resources', 'glm', 'zcode.cjs')),
    pathName: 'zcode',
    authPaths: [join(HOME, '.zcode', 'v2'), join(HOME, '.zcode', 'cli')],
    // A Node bundle, so it runs under the current node rather than directly.
    argv: (bin) => (/\.(?:c|m)?js$/i.test(bin) ? [process.execPath, bin] : [bin]).concat(['-p', 'Reply with exactly: PONG', '--no-color']),
    env: {
      // Run outside the desktop app, the bundle cannot find its own provider
      // catalogue and refuses to start a turn without this.
      ...zcodeProviderConfig(),
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
  // grok (Grok Build, xAI) — the official install script unpacks a native binary
  // into `$GROK_HOME/bin` (`~/.grok/bin` by default, `grok.exe` on Windows; the
  // PowerShell installer adds that directory to the User PATH). `%LOCALAPPDATA%`
  // is NOT a documented location — it stays listed only as the harmless second
  // guess this catalogue uses for every engine.
  //
  // The npm route exists but is a trap: the real package is `@xai-official/grok`
  // (NOT `@xai/official`), its `latest` dist-tag is stale at `0.1.4` while real
  // releases are `1.0.x`, and its `bin/grok` is a Node bootstrap that decompresses
  // the per-platform binary — so a pinned version is mandatory and the binary it
  // leaves behind is exactly the `~/.grok/bin/grok.exe` path above.
  grok: {
    paths: [
      join(HOME, '.grok', 'bin', 'grok.exe'),
      join(HOME, '.grok', 'bin', 'grok'),
      join(LOCAL, 'grok', 'bin', 'grok.exe'),
    ],
    pathName: 'grok',
    // Credentials are `~/.grok/auth.json` (OIDC; written with owner-only
    // permissions). `XAI_API_KEY` is the documented fallback and takes second
    // place to a stored session token, so a missing auth.json is a real signal.
    authPaths: [join(HOME, '.grok', 'auth.json')],
    // `-p/--single` is headless single-turn; `streaming-json` is the frame-bearing
    // format (NDJSON: one ACP session update per line), which is why the probe
    // prefers it over `plain`.
    argv: (bin) => launchPrefix(bin).concat(['-p', 'Reply with exactly: PONG', '--output-format', 'streaming-json']),
    versionArgv: (bin) => launchPrefix(bin).concat(['--version']),
    // ACP: `grok agent [options] stdio`. Options go after `agent` and BEFORE the
    // mode name (`--model`, `--always-approve`/`--yolo`, `--reauth`, …). The
    // baseline probe deliberately omits `--always-approve`: the permission mode is
    // a driver decision, and a dialect probe should not change one knob and then
    // report the result as the engine's shape.
    //
    // `launchPrefix`, not `prefixOf`: an npm-installed grok on PATH is a `.cmd`
    // shim, and this same argv is handed to the ACP prober, which spawns exactly
    // one program — so the shim has to arrive already wrapped in
    // `cmd.exe /d /s /c` rather than as a bare `.cmd` (which throws EINVAL).
    acpArgv: (bin) => launchPrefix(bin).concat(['agent', 'stdio']),
  },
  // minimaxcode (MiniMax Code) — installed from npm as `@minimax-ai/code`
  // (global prefix on the reference host: `D:\Programs\npm-global`), exposing the
  // `mcode` bin. It speaks ACP over stdio (`mcode acp`) AND a headless NDJSON
  // stream (`mcode exec --output-format stream-json`); the probe records both.
  //
  // ⚠️ Spawning `mcode` by name fails, and this is the trap worth pinning: on
  // Windows the name on PATH is only `mcode.cmd`/`mcode.ps1`/`mcode` (an sh shim),
  // so `spawn('mcode')` reports ENOENT and `spawn('mcode.cmd')` throws EINVAL —
  // Node refuses to start a `.cmd`/`.bat` without `shell: true`. The entrypoint
  // path below is therefore the FIRST candidate, and {@link launchPrefix} handles
  // the shim as the explicit fallback.
  minimaxcode: {
    paths: [
      ...MCODE_PACKAGE_DIRS.map(dir => join(dir, 'cli.js')),
      ...NPM_PREFIXES.map(prefix => join(prefix, 'mcode.cmd')),
    ],
    pathName: 'mcode',
    // Auth is NOT `~/.minimax/auth.json`. The installed bundle resolves
    // `<dataDir>/auth/<buildEnv>/<region>/<namespace>/auth.json`, where dataDir
    // defaults to `~/.minimax` (overridable with `MINIMAX_DATA_DIR`, legacy
    // `MAVIS_DATA_DIR`; `~/.mavis` is the older spellings' name for the same
    // directory), buildEnv is `prod|dev|staging` and region is `cn|en`. Both
    // regions are listed because the namespace directory only exists for the
    // region that was actually signed in.
    authPaths: [
      join(HOME, '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json'),
      join(HOME, '.minimax', 'auth', 'prod', 'en', 'mcode-public', 'auth.json'),
      join(HOME, '.minimax', 'config.yaml'),
    ],
    // `mcode exec` takes the prompt as a positional argument. `stream-json` is the
    // frame-bearing format: NDJSON `exec.started` / `session.started` /
    // `turn.started` / `item.*` / `turn.completed` records.
    argv: (bin) => launchPrefix(bin).concat(['exec', '--output-format', 'stream-json', 'Reply with exactly: PONG']),
    versionArgv: (bin) => launchPrefix(bin).concat(['--version']),
    acpArgv: (bin) => launchPrefix(bin).concat(['acp']),
    // minimaxcode is the inverse dialect of kimi on model selection, and finding
    // that out is worth one extra request in the artifact: `session/set_model` is
    // NOT implemented (`-32601 Method not found`), and `session/set_config_option`
    // takes a BARE value (`{"configId":"model","value":"m:minimax:…"}`) while the
    // object form Grok documents (`{"value":{"value":…}}`) is rejected by the
    // schema. The probe asks all three, plus the mode switch and `session/load`,
    // so the two dialects sit in one capture instead of in a paragraph of prose.
    //
    // The `model` value is copied from this agent's own `configOptions` list
    // (`session/new` advertises `m:minimax:<model>:v:<variant>`); if the model
    // catalogue moves, that one answer degrades to an invalid-VALUE rejection —
    // which the report shows verbatim — while the method-level answers
    // (`set_model` missing, object form rejected) do not depend on the id at all.
    acpArgs: [
      '--set-model', 'MiniMax-M3',
      '--config', 'model=m:minimax:MiniMax-M3:v:thinking',
      '--config-object', 'model=m:minimax:MiniMax-M3:v:thinking',
      '--set-mode', 'plan',
      '--load',
    ],
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

/**
 * The argv prefix for a probe invocation, including the Windows npm-shim case.
 *
 * A globally installed npm bin is not an executable on Windows but a `.cmd`
 * launcher, and Node refuses to start one: `spawn('mcode')` reports ENOENT (the
 * shell's `mcode` on PATH is an sh script, not a PE image, and the extensionless
 * lookup finds no `.exe`), while `spawn('mcode.cmd')` throws EINVAL out of
 * `child_process` before any process exists. Both were reproduced on the probe
 * host, so the shim is routed through `cmd.exe /d /s /c` explicitly instead of
 * being spawned by name. `shell: true` would also work but concatenates argv into
 * a command line (Node deprecates it as DEP0190), which is exactly the escaping
 * surprise this probe is supposed to avoid.
 *
 * The resolution order in {@link ENGINES} prefers the package's own `cli.js`, so
 * this branch is the fallback rather than the normal path. It is also what the ACP
 * stage needs: the prober spawns exactly one program, so an engine whose argv is
 * derived through this helper arrives there already wrapped.
 * @param bin - the resolved executable, script, or `.cmd` shim.
 * @returns the argv prefix ending in the entrypoint.
 */
function launchPrefix(bin) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin)) {
    return [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', bin]
  }
  return prefixOf(bin)
}

/** Resolve an engine's executable: a known install path first, then PATH. */
function resolveBinary(spec) {
  for (const candidate of spec.paths) {
    if (existsSync(candidate)) return { bin: candidate, how: 'known-path' }
  }
  return { bin: spec.pathName, how: 'PATH' }
}

/**
 * The ACP handshake stage, run by re-running the standalone prober.
 *
 * The ACP conversation — `initialize` → `session/new` → the model-selection
 * dialect → `session/prompt`, auto-answering `session/request_permission` and
 * answering any other reverse-RPC so the agent never hangs — is one script's worth
 * of protocol logic (`acp-handshake.mjs`). Duplicating it here would leave the
 * project with two copies that drift, so this probe SHELLS OUT to that script
 * under the current node and keeps its one-line summary; the frames themselves
 * land in `<id>.acp.md` / `<id>.acp.raw.txt`, byte-identical to a hand-run. Still
 * dependency-free: no plugin code and no npm package is imported.
 *
 * The child's exit code is reported as-is. A non-zero exit is a finding, not a
 * probe failure: `mcode` spawned by name exits -4058 with
 * `Error: spawn mcode ENOENT`, which is precisely the Windows shim trap.
 * @param id - the engine id (also the report file stem).
 * @param spec - the engine's catalogue entry.
 * @param bin - the resolved executable.
 * @param outDir - where the child writes its report and raw frames.
 * @returns the stage result, or undefined when the engine has no ACP surface.
 */
async function probeAcp(id, spec, bin, outDir) {
  if (spec.acpArgv === undefined) return undefined
  const launch = spec.acpArgv(bin)
  const [exe, ...rest] = launch
  const argv = [
    join(HERE, 'acp-handshake.mjs'),
    '--bin', exe,
    '--argv', rest.join(','),
    '--id', id,
    '--out', outDir,
    // Per-request budget. Short on purpose: an ACP agent answers `initialize` in
    // seconds, so a 30s silence means "this engine will not answer" and waiting
    // longer only delays the report.
    '--timeout', '30000',
    ...(spec.acpArgs ?? []),
  ]
  const acp = await run([process.execPath, ...argv], { timeoutMs: 150000, env: spec.env })
  const summary = (acp.stdout + acp.stderr).trim().split('\n').filter(line => line.trim() !== '').pop() ?? ''
  return { launch, argv, exitCode: acp.exitCode, timedOut: acp.timedOut, summary, stderr: acp.stderr }
}

/** One engine's probe. */
async function probe(id, outDir) {
  const spec = ENGINES[id]
  const { bin, how } = resolveBinary(spec)
  const auth = (spec.authPaths ?? []).map(path => ({ path, present: existsSync(path) }))
  const lines = [`## ${id}`, '', `- executable: \`${bin}\` (resolved via ${how})`]
  for (const entry of auth) lines.push(`- auth path: \`${entry.path}\` → ${entry.present ? 'present' : 'MISSING'}`)
  lines.push('')

  const prefix = launchPrefix(bin)
  const version = await run(spec.versionArgv(bin), { timeoutMs: 30000, env: spec.env })
  lines.push(`### version`, '', '```', (version.stdout + version.stderr).trim().slice(0, 500), '```', '')

  const help = await run([...prefix, '--help'], { timeoutMs: 30000, env: spec.env })
  lines.push(`### --help`, '', '```', (help.stdout + help.stderr).trim().slice(0, 4000), '```', '')

  if (spec.probeOnly) {
    // No engine in the catalogue uses this today — both former P2 stubs (grok,
    // minimaxcode) turned into real entries once their CLIs were installed. It is
    // kept as the escape hatch for an engine that genuinely cannot be installed on
    // a probe host: the lookup paths and the probe invocation stay reproducible, so
    // running the same command where the CLI exists produces the real frames.
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
  // The ACP stage, when the engine has one: the standalone prober writes
  // `<id>.acp.md` / `<id>.acp.raw.txt`, and this section carries the argv and the
  // one-line outcome so the per-engine report is readable without opening them.
  const acp = await probeAcp(id, spec, bin, outDir)
  if (acp !== undefined) {
    lines.push(
      '### ACP handshake', '',
      `- spawn argv: \`${acp.launch.join(' ')}\``,
      `- exit code: \`${acp.exitCode}\`${acp.timedOut ? ' (TIMED OUT)' : ''}`,
      acp.stderr.trim() === '' ? '- stderr: (empty)' : `- stderr: \`${acp.stderr.trim().split('\n')[0]}\``,
      `- summary: \`${acp.summary}\``,
      `- frames: \`${id}.acp.md\` (readable) and \`${id}.acp.raw.txt\` (every frame, both directions, timestamped)`,
      '',
    )
  }
  writeFileSync(join(outDir, `${id}.md`), lines.join('\n'))
  return {
    id,
    ran: true,
    exitCode: prompt.exitCode,
    lines: frameCount,
    answered: /PONG/.test(prompt.stdout),
    reason: prompt.timedOut ? 'timed out' : (prompt.stderr.trim().split('\n')[0] ?? ''),
    acp: acp === undefined ? undefined : { launch: acp.launch, exitCode: acp.exitCode, summary: acp.summary },
  }
}

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outDir = resolve(outIndex === -1 ? 'probe-out' : argv[outIndex + 1] ?? 'probe-out')
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
  '## ACP handshake stage',
  '',
  'Engines that expose an ACP server over stdio are probed a second time, by',
  'shelling out to `scripts/probe/acp-handshake.mjs` (same conversation as running',
  'it by hand: `initialize` → `session/new` → `session/prompt`, with every',
  'reverse-RPC answered). Frames: `<engine>.acp.md` and `<engine>.acp.raw.txt`.',
  '',
  '| engine | spawn argv | initialize | authMethods | session/new | prompt | updates seen |',
  '|---|---|---|---|---|---|---|',
  ...results.filter(r => r.acp !== undefined).map((r) => {
    const m = /initialize=(\S+) authMethods=(\d+) session\/new=(\S+) prompt=(\S+) updates=(.*)$/.exec(r.acp.summary)
    const fields = m === null
      ? ['—', '—', '—', '—', r.acp.summary.replace(/\|/g, '\\|')]
      : [m[1] ?? '—', m[2] ?? '—', m[3] ?? '—', m[4] ?? '—', (m[5] ?? '').replace(/\|/g, '\\|') || '(none)']
    return `| ${r.id} | \`${r.acp.launch.join(' ').replace(/\|/g, '\\|')}\` | ${fields[0]} | ${fields[1]} | ${fields[2]} | ${fields[3]} | ${fields[4]} |`
  }),
  '',
  '`session/new=no-id` with an authentication error is a real, reportable answer:',
  'the wire shape is still recorded, and the line in `<engine>.acp.md` says which',
  'auth method (or which out-of-band login command) the engine demands. A `prompt=`',
  'of `no` on an unauthenticated engine is therefore expected, not a probe failure.',
  '',
].join('\n'))

console.log('\n' + results.map(r => `${r.id}: ${r.ran ? `exit ${r.exitCode}, ${r.lines} line(s)` : `skipped — ${r.reason}`}`
  + (r.acp === undefined ? '' : `\n    acp: ${r.acp.summary}`)).join('\n'))
