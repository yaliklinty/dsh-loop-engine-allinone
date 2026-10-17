/**
 * Agent Client Protocol (ACP) wire types shared by every ACP engine driver.
 *
 * Three engines speak ACP over stdio (JSON-RPC 2.0): Kimi Code (`kimi acp`),
 * Grok Build (`grok agent stdio`) and MiniMax Code (`mcode acp`). The driver
 * speaks the minimal, stable subset a normal agent flow needs: initialize,
 * session/new, session/prompt, session/cancel, plus the `session/update`
 * notifications carrying incremental assistant text (`agent_message_chunk`),
 * thinking (`agent_thought_chunk`), and tool calls (`tool_call` /
 * `tool_call_update`). Tool-approval arrives as the reverse-RPC
 * `session/request_permission`, which the client must answer.
 *
 * The shapes below were READ from live frames, not from the specification, and
 * each engine's own deltas are recorded where they matter
 * (`docs/engine-registry.md`): kimi nests tool content
 * as `{ type: 'content', content: { type: 'text' } }`, all three carry text
 * chunks as `content: { type: 'text', text }`, and a model is selected through
 * a DIFFERENT method per engine (`session/set_model` on kimi,
 * `session/set_config_option` on grok and MiniMax Code). Content blocks tolerate
 * block types this build does not know by ignoring them. The image block is
 * modelled for the OUTGOING side — the bytes a dsh step delivers as an ACP
 * image block.
 *
 * @module dsh-loop-engine-allinone/driver-acp/types
 */

/** A text content block in an ACP update (the observed kimi shape). */
export interface AcpTextContent {
  readonly type: 'text'
  readonly text: string
}

/** One tool-call content block: the observed kimi `{ type: 'content', content }` nesting. */
export interface AcpToolContentBlock {
  readonly type: 'content'
  readonly content: AcpTextContent
}

/** An image content block, as ACP/MCP spells it (base64 bytes + media type). */
export interface AcpImageContent {
  readonly type: 'image'
  /** Base64-encoded image bytes. */
  readonly data: string
  /** The image's own media type. */
  readonly mimeType: string
}

/** A content block in a chunk/thought update; text is handled, others are ignored. */
export type AcpContentBlock = AcpTextContent | AcpImageContent | { readonly type: 'resource_link' | 'audio' | string; readonly [key: string]: unknown }

/** One `session/update` notification (partial; the discriminator is `sessionUpdate`). */
export interface AcpUpdate {
  readonly sessionUpdate: string
  readonly [key: string]: unknown
}

/**
 * A tool-call announcement (`sessionUpdate: 'tool_call'`).
 *
 * Measured against kimi 0.28.x: an announcement carries the call's identity
 * (`toolCallId`/`title`/`kind`) and an empty content card, but **never** its
 * input — `rawInput` only ever arrives on a later `tool_call_update` (the
 * execution-start frame).
 */
export interface AcpToolCallExt extends AcpUpdate {
  readonly sessionUpdate: 'tool_call'
  readonly toolCallId: string
  readonly title: string
  readonly kind: string
  readonly status: string
  readonly content?: readonly AcpToolContentBlock[]
  /** The call's real input; absent on the announcement (see above). */
  readonly rawInput?: unknown
}

/** A tool-call progress/result stream (`sessionUpdate: 'tool_call_update'`). */
export interface AcpToolCallStreamExt extends AcpUpdate {
  readonly sessionUpdate: 'tool_call_update'
  readonly toolCallId: string
  readonly status: string
  readonly content?: readonly AcpToolContentBlock[]
  /** The call's real input, first present on the execution-start frame. */
  readonly rawInput?: unknown
  /** The tool's raw structured output, present once the call settles. */
  readonly rawOutput?: unknown
}

/** One option the agent offers for a `session/request_permission`. */
export interface AcpPermissionOption {
  /** Opaque id the client sends back in `outcome.optionId` (the only field the agent reads). */
  readonly optionId: string
  /** Human-readable label for the option. */
  readonly name?: string
  /** Option class: `allow_once` / `allow_always` / `reject_once` / `reject_always`. */
  readonly kind?: string
}

/** The `session/request_permission` reverse-RPC params. */
export interface AcpPermissionRequest {
  readonly sessionId?: string
  /** Every option the agent will accept an answer for; empty means no answerable choice. */
  readonly options?: readonly AcpPermissionOption[]
  /** The tool call the prompt belongs to (presentation/correlation only). */
  readonly toolCall?: unknown
}

/**
 * Terminal outcome of a permission request: the option the client picked, or
 * `cancelled` when it had no answer to give.
 */
export type AcpPermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' }

/** The `session/request_permission` result the agent expects (ACP `RequestPermissionResponse`). */
export interface AcpPermissionResponse {
  readonly outcome: AcpPermissionOutcome
}

/** Result of a completed `session/prompt` request (opaque; the turn ended). */
export interface AcpPromptResult {
  readonly [key: string]: unknown
}

/** The id-scoped response to a request (result or error). */
export interface AcpResponse {
  readonly id: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** A JSON-RPC request/notification frame on the wire. */
export interface AcpFrame {
  readonly jsonrpc: '2.0'
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

/** Guards toolkit: is the frame a `session/update` notification carrying an update. */
export function isUpdateFrame(frame: AcpFrame): frame is AcpFrame & { readonly method: 'session/update'; readonly params: { readonly sessionId: string; readonly update: AcpUpdate } } {
  return frame.method === 'session/update'
    && typeof frame.params === 'object'
    && frame.params !== null
    && typeof (frame.params as { update?: unknown }).update === 'object'
    && (frame.params as { update?: unknown }).update !== null
}

/** Guards toolkit: is the frame a reverse-RPC request needing an approval answer. */
export function isPermissionRequestFrame(frame: AcpFrame): frame is AcpFrame & { readonly id: number; readonly method: 'session/request_permission' } {
  return frame.method === 'session/request_permission' && typeof frame.id === 'number'
}
