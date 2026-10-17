import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * The harness source checkout, when it is present.
 *
 * It is a sibling directory in the fork author's working tree (a ~200 MB shallow
 * clone used for types and the vendored `cordis`/`cosmokit` sources). A stranger
 * cloning THIS repository does not have it, and must not need it: the suite has to
 * run against the published npm packages instead. So the checkout is used when it
 * exists (faster, no harness install) and skipped when it does not.
 */
const mono = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
const hasHarness = existsSync(mono)
/**
 * The browser half's React entry points are harness module-table externals, not
 * dependencies of this package (`package.json` `dsh.client.external`), so a spec
 * that calls one of its components resolves them to the node stand-ins under
 * `tests/helpers/`.
 */
const fakeReact = fileURLToPath(new URL('./tests/helpers/fake-react.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: fakeReact },
      { find: /^react\/jsx-runtime$/, replacement: fakeReact },
      { find: /^react\/jsx-dev-runtime$/, replacement: fakeReact },
      // Both vendored packages resolve to SOURCE when the harness checkout is
      // present, so the suite needs no harness install and no built `lib/`. The
      // checkout is a bare `git clone`: there is no
      // `vendor/cordis/node_modules/@deepseek-ai/cosmokit` junction (pnpm only
      // creates it on an install) and no built `vendor/cosmokit/lib/index.js` for
      // it to point at. `vendor/cosmokit` has no dependencies of its own, and
      // cordis's only other external import is type-only, so the sources suffice.
      //
      // WITHOUT the checkout these aliases are omitted, and the packages resolve
      // from node_modules like any other dependency — which is what a fresh clone
      // of this repository has.
      ...hasHarness ? [
        { find: '@deepseek-ai/cordis', replacement: `${mono}vendor/cordis/src/index.ts` },
        { find: '@deepseek-ai/cosmokit', replacement: `${mono}vendor/cosmokit/src/index.ts` },
      ] : [],
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // `json` is what `scripts/coverage-gate.mjs` reads (it needs per-file
      // statement/branch maps, which the summary reporters round away); `text`
      // is for the human reading the log.
      reporter: ['text', 'json'],
      include: ['src/**/*.ts'],
      // Browser half is verified at the real profile-mount smoke; importing it
      // here would execute the client bundle (window.__ModuleLoader__) in node.
      exclude: ['src/client/**'],
      // NO `thresholds` here on purpose. The gate is `scripts/coverage-gate.mjs`,
      // which holds THIS BRANCH's files to 100% and the rest to a committed
      // floor (`.coverage-baseline.json`) instead of holding all 119 source
      // files to 100% at once — a bar this fork inherited from a repository
      // that grew one engine at a time and cannot meet after importing six at
      // once. See that script's header for the full reasoning.
    },
  },
})