/**
 * Finding an external CLI and launching it correctly, shared by the ACP engines.
 *
 * Two Windows-specific facts make "just spawn the name" wrong, and both were
 * measured on this fork's reference host rather than assumed:
 *
 *   - an npm-installed CLI is a `mcode.cmd` / `grok.cmd` SHIM, and node's spawn
 *     cannot execute a `.cmd` — `spawn('mcode', …)` fails with `ENOENT` while
 *     `mcode --version` works in a shell. The shim has to go through
 *     `cmd.exe /c`, or the package's own JS entrypoint has to be spawned under
 *     `process.execPath`;
 *   - a PATH lookup therefore has to consider `PATHEXT`, not just the bare name,
 *     or it finds the extension-less shell script npm also writes (which the OS
 *     cannot execute either).
 *
 * @module dsh-loop-engine/driver-acp/executable
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The argv prefix that launches one executable, accounting for what the resolved
 * path actually IS.
 *
 * A `.js`/`.cjs`/`.mjs` file is a package entrypoint and runs under the CURRENT
 * node (`process.execPath`), never directly (Windows answers `EFTYPE`/`ENOENT`);
 * a `.cmd`/`.bat` shim goes through the command interpreter; anything else is a
 * real executable and is spawned as itself.
 * @param bin - the resolved executable or script path.
 * @returns the argv prefix, ending in the file to run.
 */
export function execArgvPrefix(bin: string): string[] {
  if (/\.(?:c|m)?js$/i.test(bin)) return [process.execPath, bin]
  if (/\.(?:cmd|bat)$/i.test(bin)) return [process.env.ComSpec ?? 'cmd.exe', '/c', bin]
  return [bin]
}

/**
 * Resolve a bare command name against `PATH`, honouring `PATHEXT` on Windows.
 *
 * Written by hand rather than shelled out (`where`/`which`) on purpose: this runs
 * inside the plugin's own process, where spawning a helper to answer a question
 * about spawning would be its own failure mode.
 * @param name - the command name, without an extension.
 * @param env - the environment to read `PATH`/`PATHEXT` from.
 * @returns the first existing match, or undefined when nothing matches.
 */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.PATH ?? env.Path ?? ''
  if (path === '') return undefined
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(extension => extension !== '')
    : ['']
  for (const directory of path.split(separator)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Find one npm package's entrypoint under a global npm prefix.
 *
 * Both npm layouts are probed (the Windows prefix puts `node_modules` directly
 * under it; a POSIX prefix keeps it under `lib`), because the plugin may be
 * running under either and a wrong guess only costs one `existsSync`.
 * @param prefix - an npm prefix, or the directory holding `node_modules`.
 * @param pkg - the package name, scope included (`@minimax-ai/code`).
 * @param entry - the file inside the package that starts the CLI (`cli.js`).
 * @returns the entrypoint path when it exists.
 */
export function npmPackageEntry(prefix: string, pkg: string, entry: string): string | undefined {
  // A scoped name is `@scope/name`; anything else is a plain package name.
  const scoped = pkg.startsWith('@')
  const scope = scoped ? pkg.slice(0, pkg.indexOf('/')) : ''
  const name = scoped ? pkg.slice(pkg.indexOf('/') + 1) : pkg
  if (name === '' || (scoped && scope === '')) return undefined
  const relative = scoped
    ? join('node_modules', scope, name, entry)
    : join('node_modules', name, entry)
  for (const candidate of [join(prefix, relative), join(prefix, 'lib', relative)]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
