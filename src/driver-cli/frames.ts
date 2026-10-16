/**
 * The normalized frame vocabulary every CLI protocol adapter maps onto.
 *
 * A hosted CLI speaks one of four wire families — line-delimited JSON, JSON-RPC
 * 2.0, the Agent Client Protocol, or plain text — and each family spells the
 * same handful of facts differently. What a driver actually has to do with those
 * facts is identical in every case: open a turn, stream text and reasoning,
 * announce and settle tool calls, and say how the turn ended.
 *
 * So the split is: a PROTOCOL ADAPTER turns wire frames into the events below,
 * and {@link SessionSink} (`./session-sink.ts`) turns these events into the
 * durable dsh session log. Neither half knows the other's vocabulary, and an
 * engine driver is the small mapping in between plus its own transport.
 *
 * The vocabulary is deliberately narrow. Anything a protocol reports that dsh has
 * no durable place for (a queue update, a compaction notice, an extension UI
 * request) is simply not part of it: an adapter drops what it cannot express
 * rather than inventing a frame the sink would have to ignore.
 *
 * @module dsh-loop-engine/driver-cli/frames
 */

/** One tool call the engine announced, before its result is known. */
export interface ToolCallFrame {
  /** The engine's own call id; dsh keys its pending-tool map by this. */
  readonly id: string
  /** The engine's own tool name, before projection onto dsh's vocabulary. */
  readonly name: string
  /** The call's arguments, as the engine sent them (a JSON string or a value). */
  readonly arguments: unknown
}

/** One tool result the engine reported for a call it announced. */
export interface ToolResultFrame {
  /** The call id this settles; must match an announced {@link ToolCallFrame}. */
  readonly id: string
  /** The result text, already flattened to a string. */
  readonly text: string
  /** Whether the engine reported the call as failed. */
  readonly isError: boolean
}

/**
 * A protocol event, normalized.
 *
 * `delta` events are ordered and only meaningful inside a segment; `settle`
 * ends the run. An adapter that cannot stream emits `text` once and then
 * `settle` — that is exactly what the plain-text adapter does, and it is why
 * {@link EngineCapabilities.streaming} is a declaration rather than a guess.
 */
export type CliFrame =
  /** A new assistant segment began; deltas after this belong to it. */
  | { readonly kind: 'segment' }
  /**
   * Streamed answer text.
   *
   * `index` is the protocol's own content-block index when it reports one, so a
   * message with several text blocks keeps the model's own layout. An adapter
   * that has no index leaves it out, and the sink assigns one.
   */
  | { readonly kind: 'text'; readonly text: string; readonly index?: number }
  /** Streamed reasoning text; `index` as for the `text` member. */
  | { readonly kind: 'reasoning'; readonly text: string; readonly index?: number }
  /** The engine announced a tool call. */
  | { readonly kind: 'tool-call'; readonly call: ToolCallFrame }
  /** The engine reported a tool result. */
  | { readonly kind: 'tool-result'; readonly result: ToolResultFrame }
  /** Token usage for the turn, as the engine reported it. */
  | { readonly kind: 'usage'; readonly usage: CliUsage }
  /**
   * The engine's own verdict on the turn.
   *
   * A verdict is recorded rather than thrown on sight because an engine may
   * retry: a run can report an errored attempt and still succeed, so only the
   * verdict still standing when the stream ends is a failure
   * ({@link CliRunOutcome}).
   */
  | { readonly kind: 'error'; readonly message: string }
  /** The run is over; no further frames will arrive. */
  | { readonly kind: 'settle' }

/** Token usage in dsh's shape, as far as a CLI reports it. */
export interface CliUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly thinking?: number
}

/**
 * How one CLI run ended, after the sink folded every frame.
 *
 * `failed` is separate from a thrown error on purpose: an engine that reports a
 * failed turn has still run correctly from the driver's point of view — the
 * driver's job is to report the engine's answer, including a bad one. Only a
 * protocol failure (a malformed stream, a child that died mid-frame) throws.
 */
export type CliRunOutcome =
  /** The engine produced an answer. */
  | { readonly kind: 'completed' }
  /** The engine reported a failed turn; `message` is its own words. */
  | { readonly kind: 'failed'; readonly message: string }
