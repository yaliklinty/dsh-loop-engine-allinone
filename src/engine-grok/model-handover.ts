/**
 * Grok Build's dialect for a dsh endpoint: an ENVIRONMENT-ONLY handover, plus a
 * plugin-owned home directory that carries no credential at all.
 *
 * Measured on `grok` 1.0.59 (`scripts/probe`, and the raw frames in
 * `tests/engine-grok/`), and the reason each variable below exists:
 *
 *   - `GROK_MODELS_BASE_URL` moves BOTH the model list (`{base}/models`) and
 *     inference (`{base}/chat/completions`) to the dsh endpoint. Measured: with
 *     it set, `session/new` advertises exactly the endpoint's own catalog and
 *     `session/set_config_option(model, …)` accepts those ids.
 *   - `XAI_API_KEY` is the credential for that endpoint. Measured: every request
 *     the child makes then carries `Authorization: Bearer <that key>`.
 *   - `GROK_HOME` is the part that is NOT optional, and it is a security fix
 *     rather than a convenience. With the user's real `~/.grok` (signed in), the
 *     child makes a HELPER call (`POST /v1/responses`, its own built-in model) and
 *     authenticates it with the account's session JWT — while the endpoint is the
 *     third-party one `GROK_MODELS_BASE_URL` names. Measured: that JWT really does
 *     leave the machine (`eyJ…` in the request log). Pointing `GROK_HOME` at an
 *     empty plugin-owned directory removes the session credential entirely, so
 *     every request — helper included — uses `XAI_API_KEY`. Re-measured after the
 *     fix: zero `eyJ` in the log.
 *   - the helper-model variables keep those auxiliary calls on the same model
 *     instead of falling back to a built-in id the endpoint does not serve.
 *
 * The cost is the same trade pi documents: the child no longer sees the user's
 * `~/.grok` (sign-in, sessions, skills, agents). That is what "run a dsh model on
 * this engine" means — the engine's own account is not in play.
 *
 * Protocol: grok speaks the OpenAI-compatible wire (`/chat/completions`), so a
 * handover whose protocol is anything else is refused here, BEFORE a child is
 * spawned, rather than written into an environment the engine cannot use.
 *
 * @module dsh-loop-engine-allinone/engine-grok/model-handover
 */

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** Root under the OS temp dir holding one plugin-owned home per endpoint. */
const HOME_ROOT = join(tmpdir(), 'dsh-loop-engine-allinone-grok-home')

/** Homes already materialized this process, so a per-step handover never re-creates one. */
const materialized = new Set<string>()

/**
 * Remove every home this process created, at exit.
 *
 * Synchronous on purpose: an `exit` handler cannot await, and leaving the user's
 * account state out of a directory is worth the last few milliseconds. The homes
 * carry no credential, but they do carry grok's own caches from a session that
 * ran against a dsh endpoint.
 */
/* v8 ignore start -- runs only at real process exit, which a test does not reach */
process.once('exit', () => {
  for (const dir of materialized) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A directory the OS already cleaned is not an error.
    }
  }
  materialized.clear()
})
/* v8 ignore stop */

/**
 * The wire protocols grok's custom-endpoint path can speak.
 *
 * Re-measured from the released binary's request shape is not possible without a
 * live endpoint per protocol; what WAS measured is the OpenAI-compatible one
 * (`POST {base}/chat/completions`), and the vendor documents exactly that
 * convention. A protocol outside this set is refused rather than guessed.
 */
const GROK_APIS: ReadonlySet<string> = new Set(['openai-completions'])

/**
 * The plugin-owned home for one handover, materialized on first use.
 *
 * The directory name is a hash of the endpoint facts, so two sessions on the same
 * endpoint share one home and a changed endpoint gets its own. It is created
 * EMPTY: grok fills in its own defaults, and the handover rides the environment
 * (see the module comment for why an empty home is the security fix).
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the absolute path to hand the child as `GROK_HOME`.
 */
export function grokHomeFor(handover: DshModelHandover): string {
  const dir = join(
    HOME_ROOT,
    createHash('sha256')
      .update(JSON.stringify({
        provider: handover.provider,
        baseURL: handover.baseURL,
        apiKey: handover.apiKey,
      }))
      .digest('hex')
      .slice(0, 32),
  )
  if (!materialized.has(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    materialized.add(dir)
  }
  return dir
}

/**
 * Translate one dsh endpoint into grok's environment.
 *
 * A handover grok cannot speak is refused with an `LlmError` that names the
 * protocol and the engine, because the alternative — an environment grok would
 * read and then fail against — reads like a model or auth problem at the endpoint
 * while the real one is "wrong wire".
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the environment entries for the child.
 * @throws LlmError with code `GROK_UNSUPPORTED_API` when the wire is not grok's.
 */
export function grokHandoverEnv(handover: DshModelHandover): Record<string, string> {
  const api = handover.api
  if (api === undefined || !GROK_APIS.has(api)) {
    throw new LlmError(
      `grok speaks OpenAI-compatible endpoints only, but provider "${handover.provider}"`
      + ` declares the wire "${api ?? 'none'}". Pick a model from grok's own group,`
      + ` or use an engine that speaks that protocol.`,
      'GROK_UNSUPPORTED_API',
    )
  }
  return {
    GROK_HOME: grokHomeFor(handover),
    GROK_MODELS_BASE_URL: handover.baseURL,
    // The endpoint's credential, and the ONLY credential the child ever sees: the
    // empty home above removed the account token this would otherwise reuse.
    XAI_API_KEY: handover.apiKey,
    // The model itself. `GROK_MODELS_BASE_URL` makes `{base}/models` the catalog,
    // so this id is one the endpoint advertises — the session's selection.
    GROK_DEFAULT_MODEL: handover.model,
    // Helper calls (session summary, image description, prompt suggestions) run on
    // the same model instead of a built-in id this endpoint cannot serve. Web
    // search is deliberately NOT redirected: it requires the Responses API with
    // server-side search, which a chat-completions endpoint does not offer, so
    // naming the model there would only move the failure.
    GROK_SESSION_SUMMARY_MODEL: handover.model,
    GROK_IMAGE_DESCRIPTION_MODEL: handover.model,
    GROK_PROMPT_SUGGESTIONS_MODEL: handover.model,
  }
}
