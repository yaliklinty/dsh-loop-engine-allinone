# Contributing

Thanks for looking. This is a fork, and it stays useful only if it is easy to
extend — so the most valuable contribution is **another engine**, not another
refactor.

## Before you start

- Read [`docs/engine-registry.md`](docs/engine-registry.md). It is the "add an
  engine" recipe, and it records the traps that cost real time.
- **Probe first.** An engine's wire protocol is recorded from real frames before a
  driver is written for it. A guessed frame shape produces a driver that looks
  finished and silently answers nothing. `scripts/probe/` is that record.
- Never guess a capability. `capabilities` describes what the DRIVER was verified
  to do, not what the vendor's documentation claims. `images: false` for an engine
  that turns out to accept images is a bug; `images: true` for one that rejects
  them is a broken turn.

## Adding an engine

The full recipe is [`docs/engine-registry.md`](docs/engine-registry.md) §2. In
short, for an ACP engine (three of them share one skeleton, so this is four small
files):

1. add the id to `HOSTED_ENGINE_IDS` (append only — ids are persisted);
2. add its `ENGINE_REGISTRY` row (TypeScript refuses a missing one);
3. write `src/engine-<id>/{process,profile,agent,loop}.ts`;
4. add its driver factory to `src/engine-drivers.ts`;
5. add its copy to `src/client/locales.ts` and its mark to
   `src/client/engine-marks.ts`.

Then:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit
node node_modules/vitest/vitest.mjs run
node build.mjs
```

All three must pass. The suite is the contract: a new engine that lands without
tests is a new engine nobody can safely change later.

## What a pull request needs

- **A probe artifact.** Frames dumped from the real CLI, in the PR body (not
  necessarily committed — they can be large). Without it a protocol claim is a
  guess.
- **A driver smoke result**, when the CLI can run on your machine:
  `node node_modules/tsx/dist/cli.mjs scripts/probe/smoke-driver.ts <engine>` for
  the CLI-family drivers, or `smoke-acp.ts <engine>` for an ACP one.
- **Tests for the behaviour you changed**, not just for the happy path. The
  failures this codebase has actually shipped were mostly "no error, wrong data"
  (a stream that never reached the durable log, a tool call split across two
  messages, a config value that looked right and did nothing).
- **An honest UNKNOWN.** If something could not be measured on your machine, say
  so in the docs rather than filling it in. A documented gap is worth more than a
  plausible invention.

## Style

- Comments explain **why**, and they cite the measurement or the failure that
  produced the rule. "This is load-bearing because X failed" beats "this is
  important".
- Every module starts with a `@module` tag and a paragraph on what it is for.
- Do not reformat code you are not changing. Diffs should be readable.

## Reporting a bug

Include: the engine, its version (`<cli> --version`), the harness line
(0.1.5 / 0.1.7 / 0.2.0), the profile, and what you expected vs what happened. If
the bug is protocol-shaped, the probe output is the single most useful thing you
can attach.

## Security

Engine credentials are the engines' own business: this plugin never reads, writes
or refreshes them, and a profile should never contain one. If you find a path where
that is not true, treat it as a security report — see [SECURITY.md](SECURITY.md).
