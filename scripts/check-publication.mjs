#!/usr/bin/env node
/**
 * Pre-publication check for a fork about to be pushed to a public repository.
 *
 * The failure this prevents is not a crash, it is a leaked credential or a
 * dead link: a fork published with the upstream `repository` field sends people
 * to the wrong project, and a fork published with a personal absolute path or an
 * engine's `auth.json` leaks something that cannot be un-leaked.
 *
 * It reads only what git TRACKS (so a stray untracked directory cannot hide a
 * problem), and it exits non-zero on the first blocking finding.
 *
 * ```sh
 * node scripts/check-publication.mjs
 * ```
 *
 * @module scripts/check-publication
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every tracked path, relative to the repo root. */
function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(line => line.trim() !== '')
}

const files = trackedFiles()
const problems = []
const warnings = []

// ---- 1) placeholders that must be filled before publishing -------------------
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
for (const field of ['repository', 'bugs', 'homepage']) {
  const value = JSON.stringify(pkg[field] ?? '')
  if (value.includes('<your-account>')) {
    problems.push(`package.json ${field} still says <your-account>: ${value}`)
  }
}

// ---- 2) secrets and personal paths in tracked text files --------------------
/** Files worth scanning: text-ish and small. A binary is skipped, not guessed at. */
const TEXT = /\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|txt|mts|cts)$/i

/** Patterns that are secrets in this project's context. */
const SECRET_PATTERNS = [
  { name: 'api key literal', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'engine credential file', re: /["']auth\.json["']\s*:\s*["'][^"']+/ },
  { name: 'named credential ref', re: /\b(?:BUDDY|WORKBUDDY|COMMANDCODE|MINIMAX|QODERCN?|ZCODE)_ACCOUNT_[A-Z0-9]+/ },
]

/**
 * Placeholders are not leaks: `C:/Users/me/` in a README example and
 * `C:\Users\tester\` in a fixture are the RIGHT way to write a path in a public
 * repo. Only a name that is neither a placeholder nor a well-known system account
 * is treated as somebody's real home directory.
 */
const PLACEHOLDER_USERS = new Set([
  'me', 'you', 'user', 'username', 'tester', 'test', 'example', 'name',
  'alice', 'bob', 'someone', 'yourname', 'your-name', 'your_user',
])

/** Absolute paths that only exist on one machine. */
const PATH_PATTERNS = [
  {
    name: 'a real Windows home path',
    re: /[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)/,
    keep: match => !PLACEHOLDER_USERS.has(match[1].toLowerCase()),
  },
  { name: 'the fork project path', re: /20261017_dsh-loop-engine-fork/ },
  {
    name: 'a real POSIX home path',
    re: /\/c\/Users\/([A-Za-z0-9._-]+)/,
    keep: match => !PLACEHOLDER_USERS.has(match[1].toLowerCase()),
  },
]

for (const file of files) {
  if (!TEXT.test(file)) continue
  let text
  try {
    text = readFileSync(resolve(ROOT, file), 'utf8')
  } catch {
    continue
  }
  // This file necessarily contains the patterns it looks for.
  const isSelf = file.endsWith('check-publication.mjs')
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) problems.push(`${file}: possible ${name}`)
  }
  if (isSelf) continue
  for (const { name, re, keep } of PATH_PATTERNS) {
    const match = re.exec(text)
    if (match === null) continue
    if (keep !== undefined && !keep(match)) continue
    problems.push(`${file}: ${name} in a tracked file`)
  }
}

// ---- 3) credential-shaped files must not be tracked -------------------------
const FORBIDDEN_FILES = /(?:^|\/)(?:auth\.json|auth-state\.json|credentials\.json|\.credentials\.yaml|\.env)$/
for (const file of files) {
  if (FORBIDDEN_FILES.test(file)) problems.push(`${file}: a credential file is tracked`)
}

// ---- 4) the docs a public repository is expected to carry -------------------
for (const required of ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md']) {
  if (!files.includes(required)) warnings.push(`missing ${required} (expected for a public repo)`)
}

// ---- 5) citations to files that do not exist in THIS repository -------------
const OUTSIDE = /\b(?:output\/probes|output\/协议|data\/vendor-docs|data\/acp-scratch|data\/user-icons)/
for (const file of files) {
  if (!TEXT.test(file)) continue
  let text
  try {
    text = readFileSync(resolve(ROOT, file), 'utf8')
  } catch {
    continue
  }
  if (OUTSIDE.test(text)) {
    problems.push(`${file}: cites a path outside this repository (unreadable after cloning)`)
  }
}

// ---- report ----------------------------------------------------------------
const lines = []
lines.push(`checked ${files.length} tracked files`)
if (warnings.length > 0) {
  lines.push('', 'WARNINGS (not blocking):')
  for (const warning of warnings) lines.push(`  - ${warning}`)
}
if (problems.length > 0) {
  lines.push('', 'BLOCKING:')
  for (const problem of problems) lines.push(`  - ${problem}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exit(1)
}
lines.push('', 'OK - nothing blocking found.')
process.stdout.write(`${lines.join('\n')}\n`)
