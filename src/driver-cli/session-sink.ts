/**
 * The shared session sink: one implementation of "turn these frames into the
 * durable dsh session log", used by every CLI driver.
 *
 * This is the half of a driver that is genuinely hard to get right, and it is
 * identical for every engine, so it lives in exactly one place. What it owns:
 *
 *  - **The assistant-message lifecycle.** Content arrives as deltas, is held,
 *    and is committed as a durable `assistant/message` at a boundary. The live
 *    attempt's frames are published as `agent/assistant-stream` and its compact
 *    stream travels with the message ({@link DriverAssistantStream}).
 *  - **The tool-call/tool-result pairing Session V4 enforces.** A `tool/result`
 *    must follow the `assistant/message` that carries its `tool-call` block, and
 *    each call may be settled EXACTLY once — a second result for one id is
 *    refused on load and bricks the whole session log. Engines report results
 *    inconsistently (twice for one execution, or before the message that
 *    requested it), so this class synthesizes the owning message when it has to
 *    and drops the repeat.
 *  - **Step rotation.** A settled tool result means the segment that ran it is
 *    complete, so the next assistant content belongs to a new step. Rotating at
 *    a message boundary keeps the calls one model turn announced together in one
 *    step. A step that still OWES a result never rotates — that would strand the
 *    call in a step that can never resolve it, which is itself a log V4 refuses.
 *  - **Closing a step honestly.** `closeStep` writes an explicit failure result
 *    for every call still unsettled, because a `step/end` carrying an unresolved
 *    announcement is a log that will not load.
 *
 * What it deliberately does NOT own: the turn/step loop, cancellation, the
 * inbox, the prompt, and the protocol. Those stay in the driver, because they
 * are where engines actually differ.
 *
 * @module dsh-loop-engine/driver-cli/session-sink
 */

import type { AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CliFrame, CliUsage, ToolCallFrame } from './frames.ts'
import type { HostedEngineId } from '../engine-registry.ts'
import { normalizeHostedToolCall } from '../driver-core/hosted-tool-vocabulary.ts'
import { DriverAssistantStream } from '../driver-core/assistant-stream.ts'
import { createStepTools, type StepTools } from '../driver-core/step-tools.ts'
import { closeStep, settleResult } from '../driver-core/step-close.ts'
import { appendSystemHeadIfMissing } from '../driver-core/system-head.ts'

/** Where one run's frames land: the session position they belong to. */
export interface SinkPosition {
  /** The durable turn owning this run. */
  turn: number
  /** The durable step this run opened on; the sink may rotate it. */
  step: number
}

/**
 * What the sink needs from the driver it serves.
 *
 * Passed as a small interface rather than as the driver itself, so the sink can
 * be tested without a driver and so it is obvious what it depends on. Every
 * member is a question the sink cannot answer itself: which engine is speaking
 * (tool-name projection is per-engine), which provider label to log, and where
 * the live attempt's frames go.
 */
export interface SinkHost {
  /** The session being written. */
  readonly session: Session
  /** This agent's session id, for the attempt identity of a live stream. */
  readonly sessionId: SessionId
  /** The engine whose vocabulary tool names are projected from. */
  readonly engine: HostedEngineId
  /** The provider route label logged into message provenance. */
  readonly provider: string
  /** The model label logged into message provenance. */
  readonly model: string
  /** Agent-scoped notification publisher, for live stream frames. */
  readonly dispatch: AgentEventDispatch
  /**
   * Called when the sink rotates to a new step, so the driver can record the
   * rotation and re-run whatever it owes a fresh step (announcing the step,
   * re-checking the system head).
   *
   * The sink rotates; the DRIVER owns what a rotation means for its own
   * bookkeeping, which is why this is a callback rather than something the sink
   * does silently.
   * @param step - the step number now open.
   */
  onStepRotated(step: number): void
}

/**
 * The shared sink. One instance per agent lifecycle.
 *
 * Not re-entrant and not concurrent: a session runs one step at a time, and the
 * sink's buffers describe that one run. A second concurrent run on one session
 * is refused upstream (the router never hands a live session to two machines).
 */
export class SessionSink {
  private readonly stepTools: StepTools = createStepTools()
  /** Calls announced in this step whose results have landed. */
  private settledTools = 0
  /** This run's live attempt, opened on the first chunk and settled by a message. */
  private live: DriverAssistantStream | undefined
  /** Agent-lifecycle-local attempt counter, naming each streamed attempt. */
  private streamAttempts = 0
  /** The assistant message being assembled, if any. */
  private held: { content: ContentBlock[] } | undefined
  /** Text blocks already block-start-ed, by content index. */
  private readonly startedText = new Set<number>()
  /** Reasoning blocks already block-start-ed, by content index. */
  private readonly startedReasoning = new Set<number>()
  /** Reasoning accumulated by content index, for engines that stream it without a final block. */
  private readonly thinkingByIndex = new Map<number, string>()
  /** Call ids already announced, so a protocol that repeats one announces it once. */
  private readonly announced = new Set<string>()
  /** Call ids already written a result, so a repeated report is dropped. */
  private readonly settled = new Set<string>()
  /** Tool-call blocks not yet folded into a flushed assistant message. */
  private pendingToolCalls: ContentBlock[] = []
  /** `tool/call` events owed by the pending blocks, appended once their message lands. */
  private pendingCallLog: Array<{ callId: string; name: string; arguments: string }> = []
  /** Calls released by the flush that just folded their owner message. */
  private callsToLog: Array<{ callId: string; name: string; arguments: string }> = []
  /** Last usage snapshot, folded onto the message that closes the run. */
  private lastUsage: TokenUsage | undefined
  /** The engine's standing verdict on this run; cleared by a later successful report. */
  private failure: string | undefined
  /** Whether an assistant message was already committed for this run. */
  private assistantFlushed = false
  /** Whether a segment has been opened (so a `segment` frame before content is not double-counted). */
  private segmentOpen = false

  constructor(private readonly host: SinkHost) {}

  /**
   * @param host - the driver-side facts the sink cannot answer itself.
   */
  /** Reset per-step bookkeeping. Called by the driver when a step opens. */
  beginStep(): void {
    this.stepTools.clear()
    this.settledTools = 0
    this.held = undefined
    this.startedText.clear()
    this.startedReasoning.clear()
    this.thinkingByIndex.clear()
    this.pendingToolCalls = []
    this.pendingCallLog = []
    this.callsToLog = []
    this.assistantFlushed = false
    this.segmentOpen = false
  }

  /**
   * Reset the per-RUN bookkeeping that must not leak between steps.
   *
   * `announced` and `settled` are deliberately NOT reset: call ids are unique
   * for the life of a session, so retaining them only widens duplicate
   * suppression and can never hide a legitimate result. A protocol that reuses
   * an id across steps would be malformed anyway.
   */
  beginRun(): void {
    this.lastUsage = undefined
    this.failure = undefined
  }

  /** The step number currently open, as the sink has rotated it. */
  stepOf(position: SinkPosition): number {
    return position.step
  }

  /** The calls this step still owes a result, in announcement order. */
  get pendingCalls(): readonly ToolCallId[] {
    return this.stepTools.pending
  }

  /**
   * The engine's standing verdict on the run so far.
   * @returns the failure message, or undefined when the run is not (or no longer) failed.
   */
  get runFailure(): string | undefined {
    return this.failure
  }

  /**
   * Consume one normalized frame.
   *
   * The position object is mutated in place when the sink rotates a step, so the
   * caller's own view of "which step is open" follows — that is what keeps the
   * turn loop's fail-safe step close on the step that is actually open rather
   * than the one the run started under.
   * @param frame - the normalized frame.
   * @param position - the turn/step this run belongs to; `step` may be bumped.
   */
  accept(frame: CliFrame, position: SinkPosition): void {
    switch (frame.kind) {
      case 'segment':
        this.openSegment(position)
        return
      case 'text':
        this.streamChunk('text', frame.text, position)
        return
      case 'reasoning':
        this.streamChunk('reasoning', frame.text, position)
        return
      case 'tool-call':
        this.emitToolCall(frame.call)
        return
      case 'tool-result':
        this.settleTool(frame.result.id, frame.result.text, frame.result.isError, position)
        return
      case 'usage':
        this.lastUsage = mapUsage(frame.usage)
        return
      case 'error':
        // Recorded, never thrown on sight: an engine that retries emits one
        // errored attempt per try and can still succeed, so only the verdict
        // still standing when the stream ends is a failure.
        this.failure = frame.message
        return
      case 'settle':
        return
    }
  }

  /**
   * Open a new assistant segment.
   *
   * A segment after a settled tool result is the next step: the previous
   * segment is complete and the content about to arrive belongs to the next one.
   * A step that still owes a result does not rotate (see the module note).
   * @param position - the open position, mutated when a rotation happens.
   */
  private openSegment(position: SinkPosition): void {
    if (this.segmentOpen) return
    this.segmentOpen = true
    if (this.settledTools === 0 || !this.stepTools.balanced) return
    this.closeOpenStep(position)
    position.step += 1
    this.host.onStepRotated(position.step)
    this.beginStep()
    this.segmentOpen = true
  }

  /** Close the step currently open, writing explicit failures for anything unsettled. */
  private closeOpenStep(position: SinkPosition): void {
    closeStep(this.host.session, this.stepTools, position.turn, position.step)
  }

  /**
   * Close the step the sink currently holds, for the driver's step teardown.
   * @param position - the open position.
   */
  closeStep(position: SinkPosition): void {
    this.closeOpenStep(position)
    this.stepTools.clear()
    this.settledTools = 0
  }

  /** Open the step's own surface head, once, when the driver opens a step. */
  openStep(position: SinkPosition): void {
    appendSystemHeadIfMissing(this.host.session, position.turn, position.step)
  }

  /**
   * Stream one chunk, opening its block and its live attempt as needed.
   * @param kind - whether this is answer text or reasoning.
   * @param text - the delta.
   * @param position - the open position, for the live attempt's framing.
   */
  private streamChunk(kind: 'text' | 'reasoning', text: string, position: SinkPosition): void {
    // A chunk with no open segment means the protocol does not mark segment
    // starts (or marks them differently): open one implicitly, so the step
    // rotation above still happens at the right boundary.
    this.openSegment(position)
    const index = kind === 'text' ? this.startedText.size : this.startedReasoning.size
    if (kind === 'text') {
      if (!this.startedText.has(index)) {
        this.startedText.add(index)
        this.currentStream(position).push({ type: 'block-start', index, blockType: 'text' })
      }
      this.currentStream(position).push({ type: 'text-delta', index, text })
      return
    }
    if (!this.startedReasoning.has(index)) {
      this.startedReasoning.add(index)
      this.currentStream(position).push({ type: 'block-start', index, blockType: 'reasoning' })
    }
    this.currentStream(position).push({ type: 'reasoning-delta', index, text })
    this.thinkingByIndex.set(index, (this.thinkingByIndex.get(index) ?? '') + text)
  }

  /**
   * The live attempt for the current segment, opened on first use.
   *
   * Chunks open one; the durable assistant message they built settles it and the
   * next chunk opens a fresh attempt, so every message carries exactly its own
   * timed stream.
   * @param position - the open position, for the attempt's turn/step framing.
   * @returns the live attempt.
   */
  private currentStream(position: SinkPosition): DriverAssistantStream {
    if (this.live === undefined) {
      this.live = new DriverAssistantStream(
        this.host.sessionId,
        ++this.streamAttempts,
        position.turn,
        position.step,
        frame => this.host.dispatch.emit('agent/assistant-stream', { frame }),
      )
      this.live.start()
    }
    return this.live
  }

  /**
   * Record one announced tool call.
   *
   * The call is projected onto dsh's vocabulary ONCE, and the same projected
   * name and arguments go to both the assistant message's `tool-call` block and
   * the durable `tool/call` event — Session V4 pairs the two by id and refuses a
   * log whose block and event disagree.
   * @param call - the announced call.
   */
  private emitToolCall(call: ToolCallFrame): void {
    if (this.announced.has(call.id)) return
    this.announced.add(call.id)
    const argumentsValue = typeof call.arguments === 'string'
      ? call.arguments
      : JSON.stringify(call.arguments ?? {})
    const normalized = normalizeHostedToolCall(this.host.engine, call.name, argumentsValue)
    this.pendingToolCalls.push({
      type: 'tool-call',
      id: ToolCallId(call.id),
      name: normalized.name,
      arguments: normalized.arguments,
    })
    this.pendingCallLog.push({ callId: call.id, name: normalized.name, arguments: normalized.arguments })
  }

  /**
   * Settle one tool call, exactly once.
   *
   * The owning assistant message is flushed first when the call has none yet:
   * the durable surface must always pair a result with a preceding assistant
   * `tool-call` block, and an engine that executed a call without streaming an
   * assistant message first would otherwise leave the result orphaned.
   * @param id - the call being settled.
   * @param text - the result text.
   * @param isError - whether the engine reported a failure.
   * @param position - the open position.
   */
  private settleTool(id: string, text: string, isError: boolean, position: SinkPosition): void {
    if (this.settled.has(id)) return
    this.settled.add(id)
    this.ensureToolCallOwner(position)
    settleResult(this.stepTools, ToolCallId(id), () => {
      this.host.session.append('tool/result', {
        turn: position.turn,
        step: position.step,
        // The same factory every other driver uses, so the durable message is
        // byte-identical in shape to one an in-process turn would produce —
        // which is what lets a hosted transcript be replayed on the harness loop.
        message: createToolResultMessage({
          callId: ToolCallId(id),
          content: [{ type: 'text', text: text === '' ? '(no content)' : text }],
          isError,
        }),
      }, { surfaceOp: 'append' })
      this.settledTools += 1
    })
  }

  /**
   * Flush a synthesized assistant message carrying any tool-call blocks that have
   * no committed owner yet.
   * @param position - the open position.
   */
  private ensureToolCallOwner(position: SinkPosition): void {
    if (this.pendingToolCalls.length === 0) return
    this.flushHeld(position)
    this.held = { content: [...this.pendingToolCalls] }
    this.pendingToolCalls = []
    this.callsToLog = this.pendingCallLog
    this.pendingCallLog = []
    this.flushHeld(position)
  }

  /**
   * Commit the held assistant message, if any.
   * @param position - the open position.
   * @param usage - usage to attach, when this message closes the run.
   */
  private flushHeld(position: SinkPosition, usage?: TokenUsage): void {
    if (this.held === undefined) return
    const attempt = this.live
    const content = this.foldPendingCalls(this.held.content)
    const data = {
      turn: position.turn,
      step: position.step,
      message: createAssistantMessage({
        content,
        source: { provider: this.host.provider, model: this.host.model },
      }),
      ...usage === undefined ? {} : { usage },
      stream: attempt?.stream ?? [],
    }
    if (attempt === undefined) {
      this.host.session.append('assistant/message', data, { surfaceOp: 'append' })
    } else {
      attempt.settle(() => this.host.session.append('assistant/message', data, { surfaceOp: 'append' }).seq)
      this.live = undefined
    }
    this.held = undefined
    // The message just committed owns these calls; log them AFTER it, so the
    // durable log reads assistant/message → tool/call → tool/result.
    for (const call of this.callsToLog) {
      this.stepTools.announce(ToolCallId(call.callId))
      this.host.session.append('tool/call', {
        turn: position.turn,
        step: position.step,
        callId: ToolCallId(call.callId),
        name: call.name,
        arguments: call.arguments,
      })
    }
    this.callsToLog = []
  }

  /** Fold any not-yet-flushed tool-call blocks into the message being committed. */
  private foldPendingCalls(content: ContentBlock[]): ContentBlock[] {
    if (this.pendingToolCalls.length === 0) return content
    const folded = [...content, ...this.pendingToolCalls]
    this.pendingToolCalls = []
    this.callsToLog = this.pendingCallLog
    this.pendingCallLog = []
    return folded
  }

  /**
   * Commit the assistant message a whole-message protocol reports.
   *
   * A text-protocol engine has no deltas: it hands over a finished answer, and
   * this is where it becomes the same durable shape a streaming engine produces.
   * Reasoning is folded in before the text, matching the ordering the in-process
   * loop produces, and any reasoning the protocol streamed but omitted from its
   * final message is preserved rather than lost.
   * @param text - the answer text.
   * @param reasoning - the reasoning text, when the engine reported it separately.
   * @param position - the open position.
   */
  commitWholeMessage(text: string, reasoning: string | undefined, position: SinkPosition): void {
    this.openSegment(position)
    this.flushHeld(position)
    const content: ContentBlock[] = []
    if (reasoning !== undefined && reasoning !== '') content.push({ type: 'reasoning', text: reasoning })
    if (text !== '') content.push({ type: 'text', text })
    this.held = { content }
    this.assistantFlushed = true
    this.flushHeld(position, this.lastUsage)
  }

  /**
   * Commit a message built from an authoritative content-block list.
   *
   * The streaming engines' path: the protocol's own final message is the source
   * of truth, and anything it omits that was streamed (reasoning, pending tool
   * calls) is folded back in so the durable log never loses content the model
   * produced.
   * @param content - the blocks the protocol reported.
   * @param position - the open position.
   * @param usage - usage to attach when this closes the run.
   */
  commitBlocks(content: ContentBlock[], position: SinkPosition, usage?: TokenUsage): void {
    this.openSegment(position)
    let blocks = [...content]
    if (!blocks.some(block => block.type === 'reasoning') && this.thinkingByIndex.size > 0) {
      const folded: ContentBlock[] = [...this.thinkingByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => ({ type: 'reasoning', text }))
      blocks = [...folded, ...blocks]
    }
    this.flushHeld(position)
    this.held = { content: blocks }
    this.assistantFlushed = true
    this.flushHeld(position, usage ?? this.lastUsage)
  }

  /**
   * Finish the run: commit anything still held and report the engine's verdict.
   *
   * The verdict is checked before "did we commit a message", because an engine
   * can settle cleanly with every turn failed (and send no reply at all);
   * reporting that as success would hand the user a silent, empty turn. Its own
   * words are the more useful thing to report in that case.
   * @param position - the open position.
   * @returns how the run ended.
   */
  finish(position: SinkPosition): { kind: 'completed' } | { kind: 'failed'; message: string } {
    this.flushHeld(position, this.lastUsage)
    if (this.live !== undefined && !this.live.ended) this.live.abandon()
    if (this.failure !== undefined) return { kind: 'failed', message: this.failure }
    if (!this.assistantFlushed) {
      // A run that produced nothing at all is not a success: the driver's caller
      // expects an answer, and an empty turn reported as completed is the silent
      // degradation this plugin exists not to produce.
      return { kind: 'failed', message: 'the engine ended the run without producing a reply' }
    }
    return { kind: 'completed' }
  }
}

/**
 * Project one engine-reported usage record onto dsh's `TokenUsage`.
 *
 * Absent fields are omitted rather than defaulted to zero: dsh distinguishes
 * "reported zero" from "not reported", and a fabricated zero would corrupt the
 * context accounting the compaction path reads.
 * @param usage - the engine's usage record.
 * @returns dsh's usage shape.
 */
export function mapUsage(usage: CliUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead === undefined ? {} : { cacheReadTokens: usage.cacheRead },
    ...usage.cacheWrite === undefined ? {} : { cacheWriteTokens: usage.cacheWrite },
    ...usage.thinking === undefined ? {} : { reasoningTokens: usage.thinking },
  }
}

/**
 * Flatten one engine tool result to the text dsh stores.
 *
 * Engines report a result as a string, as a list of content blocks, or as an
 * arbitrary JSON value; dsh's durable shape is text. Anything that is not text
 * is JSON-encoded rather than dropped, so a structured result stays inspectable
 * in the transcript instead of vanishing.
 * @param result - the engine's result payload.
 * @returns the text to store.
 */
export function flattenToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return ''
  if (Array.isArray(result)) {
    return result
      .map(block => {
        if (typeof block === 'string') return block
        const record = block as Record<string, unknown> | null
        if (record !== null && typeof record === 'object' && typeof record.text === 'string') return record.text
        return JSON.stringify(block)
      })
      .filter(segment => segment !== '')
      .join('\n\n')
  }
  const record = result as Record<string, unknown>
  if (typeof record.content === 'string') return record.content
  if (Array.isArray(record.content)) return flattenToolResult(record.content)
  return JSON.stringify(result)
}

/** A message from any source, for the drivers that re-read the transcript. */
export type SinkMessage = Message
