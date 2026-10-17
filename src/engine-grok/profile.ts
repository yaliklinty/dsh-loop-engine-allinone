/**
 * Grok Build's ACP dialect: the shared ACP body with grok's own handshake.
 *
 * Three measured facts shape this profile, all of them from real frames dumped by
 * `scripts/probe/acp-handshake.mjs` against the released `grok` 1.0.59 binary:
 *
 *   1. `initialize` answers `protocolVersion: 1`, advertises ONE auth method
 *      (`id: grok.com`, name `Grok`) and reports
 *      `promptCapabilities.image: false` — so this engine never receives image
 *      blocks from the driver;
 *   2. `session/new` REFUSES an unauthenticated client with
 *      `-32000 Authentication required / "no auth method id provided"`, which is
 *      ACP's own flow: the client answers `authenticate` with the advertised
 *      method id, then opens the session. Grok on a signed-in host is expected to
 *      accept `authenticate` immediately (its cached credentials live in
 *      `~/.grok/auth.json`); on an unsigned host that call is what starts the
 *      vendor's sign-in, and a failure after it is reported with the registry's
 *      own login hint so the user is told what to run instead of reading a raw
 *      JSON-RPC error;
 *   3. the model is selected through `session/set_config_option` (Grok's user
 *      guide documents the `{ value }` wrapper). MiniMax Code rejects that wrapper
 *      and takes the bare value, so the driver tries the documented spelling and
 *      falls back to the bare one, recording which the engine accepted — the
 *      dialect difference is real and guessing it would break a working engine.
 *
 * `session/new` also carries `_meta.yoloMode` when the session's dsh approval
 * knobs auto-approve, which maps the dsh policy onto Grok's own always-approve
 * switch. When they do not, the driver leaves it off and answers the reverse-RPC
 * `session/request_permission` itself (denying under an `ask` policy, since the
 * unattended runtime has no human to ask).
 *
 * @module dsh-loop-engine/engine-grok/profile
 */

import { acpDefaultApproval } from '../driver-acp/approval.ts'
import type { AcpClient } from '../driver-acp/client.ts'
import type { AcpEngineProfile } from '../driver-acp/profile.ts'
import { acpProtocolVersionOf, descriptorOf } from '../engine-registry.ts'
import { grokAcpArgv } from './process.ts'

/** Grok's model config option id, as its user guide documents it. */
export const GROK_MODEL_CONFIG_ID = 'model'

/** The registry's login instruction, used when the engine reports it needs auth. */
export function grokLoginHint(): string {
  return descriptorOf('grok').loginHint ?? 'sign in to Grok, then retry'
}

/**
 * Whether an error from `session/new` is ACP's "this client is not authenticated
 * yet" refusal.
 *
 * Matched on the message because that is what the shared client surfaces from an
 * error frame (`settle()` keeps `error.message`); measured text on 1.0.59 is
 * exactly `Authentication required`.
 * @param error - the rejection from `session/new`.
 * @returns whether the agent refused for want of authentication.
 */
export function isAuthenticationRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /authentication required|not authenticated|unauthenticated|unauthorized/i.test(message)
}

/**
 * The first auth method id an `initialize` result advertises.
 *
 * The driver takes the FIRST method rather than choosing among several: ACP
 * publishes them in the agent's own preference order, and a client that ranks them
 * itself would be inventing a policy the engine already stated.
 * @param initializeResult - the raw `initialize` result.
 * @returns the method id, or undefined when the agent advertised none.
 */
export function firstAuthMethodId(initializeResult: unknown): string | undefined {
  const methods = (initializeResult as { authMethods?: unknown } | undefined)?.authMethods
  if (!Array.isArray(methods)) return undefined
  for (const method of methods) {
    const id = (method as { id?: unknown } | undefined)?.id
    if (typeof id === 'string' && id !== '') return id
  }
  return undefined
}

/**
 * Select Grok's model through `session/set_config_option`, trying the spelling the
 * vendor documents first.
 *
 * Grok's guide shows the wrapped form (`value: { value: 'grok-4.6' }`), while the
 * bare form is what MiniMax Code was measured to accept. Since the signed-in
 * answer could not be measured on this host (no account), the driver does what the
 * documentation says and falls back on the protocol's own "invalid params"
 * rejection — an engine that prefers the bare value answers `-32602`, which is a
 * decidable signal rather than a guess.
 * @param client - the connected ACP client.
 * @param sessionId - the ACP session.
 * @param model - the model id to select.
 */
export async function selectGrokModel(client: AcpClient, sessionId: string, model: string): Promise<void> {
  try {
    await client.setConfigOptionValue(sessionId, GROK_MODEL_CONFIG_ID, model)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/invalid params|-32602/i.test(message)) throw error
    await client.setConfigOption(sessionId, GROK_MODEL_CONFIG_ID, model)
  }
}

/** Grok Build's ACP dialect, as the shared driver reads it. */
export function grokProfile(bin: string): AcpEngineProfile {
  return {
    engine: 'grok',
    label: 'grok',
    errorCode: 'GROK_NO_RESULT',
    protocolVersion: acpProtocolVersionOf('grok'),
    argv: () => grokAcpArgv(bin),
    // Measured: `promptCapabilities.image` is false, so the shared body keeps
    // image blocks out of the prompt entirely.
    images: false,
    approve: acpDefaultApproval,
    selectModel: selectGrokModel,
    openSession: async (client, cwd, session, initializeResult) => {
      const extra = acpDefaultApproval(session) ? { _meta: { yoloMode: true } } : {}
      try {
        return await client.newSession(cwd, extra)
      } catch (error: unknown) {
        const methodId = firstAuthMethodId(initializeResult)
        if (!isAuthenticationRequired(error) || methodId === undefined) throw error
        // ACP's own flow: answer with the method the agent published, then retry.
        //
        // BOTH halves are wrapped, and that is load-bearing rather than tidy: on a
        // signed-out host `authenticate` is what starts the vendor's browser
        // sign-in, so with no terminal it can take the child down instead of
        // answering. Measured on this fork's host: the child exits and the shared
        // client rejects every pending request with "grok acp process exited
        // unexpectedly" — a message that tells the user nothing they can act on.
        // Either failure therefore becomes the registry's login hint, with the
        // engine's own words kept as the cause.
        try {
          await client.authenticate(methodId)
          return await client.newSession(cwd, extra)
        } catch (retryError: unknown) {
          throw new Error(`grok: ${grokLoginHint()}`, { cause: retryError })
        }
      }
    },
  }
}
