# Security policy

## What this plugin touches

- **It does not own credentials.** Every hosted engine reads its own credentials
  from its own directory (`~/.grok/auth.json`, `~/.kimi-code/…`, `~/.minimax/…`,
  the Claude/Codex/Pi installs' own files). The plugin only checks whether an auth
  path EXISTS, to show a signed-in/not-signed-in hint in the settings page. It
  never opens one for reading its contents.
- **It spawns external processes.** Every engine's CLI runs as a child, and every
  child is spawned through the harness's subprocess seam (`ctx.subprocess`), which
  is the privilege boundary. ACP engines additionally declare client-side
  capabilities: an engine may ask the plugin to read a file or run a command. Both
  go through the harness's own services (`ctx.fs`, `ctx.shell`), so the engine's
  request is subject to the same policy as the harness's own tools — and the
  terminal bridge REFUSES rather than falling back to an unconfined spawn when no
  shell service is present.
- **It writes to one place in your profile**: the managed block in the profile's
  `cordis.patch.yml`, plus the agent presets it authors. Both are documented in the
  README's install notes, and the block is what uninstall must remove.

## Reporting

Open a private security advisory on the repository, or email the maintainer listed
in `package.json`'s `author` field. Please do not open a public issue for a
credential-handling or sandbox-bypass problem.

Include: what you expected, what happened, the profile composition (redact
credentials), and the engine involved. A reproduction that does not need your own
account is worth much more than one that does.

## What is NOT a vulnerability

- An engine's own tool call being denied by the harness sandbox. That is the
  sandbox working; the plugin's job is to route the request INTO it, not around it.
- A hosted engine reporting that it has no subscription or quota. The plugin
  reports the engine's own words rather than hiding them.
- The plugin failing to start an engine whose CLI is not installed. The engine is
  an external dependency by design; see the README's Requirements table.
