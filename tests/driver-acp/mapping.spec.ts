/**
 * Unit tests for the `kimi acp` event mapping: update kind predicates, chunk
 * delta extraction, tool identity/stream helpers, and the tool-result projection.
 * @module tests/driver-acp/mapping
 */

import { describe, expect, it } from 'vitest'
import {
  chunkDelta,
  isTextChunk,
  isThoughtChunk,
  isToolCall,
  isToolCallUpdate,
  isToolErrorStatus,
  isToolSettledStatus,
  toolCallIdOf,
  toolCallName,
  toolContentText,
  toolRawInput,
  toolResult,
} from '../../src/driver-acp/mapping.ts'
import type { AcpToolCallStreamExt, AcpUpdate } from '../../src/driver-acp/types.ts'
import { toolResultRole, toolResultView } from '../helpers/harness-generation.ts'

const msg = (text: string): AcpUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const thought = (text: string): AcpUpdate => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
const toolCall = (id: string, title: string): AcpUpdate => ({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status: 'pending', content: [] })
const toolStream = (id: string, status: string, text: string): AcpUpdate => ({
  sessionUpdate: 'tool_call_update', toolCallId: id, status,
  content: [{ type: 'content', content: { type: 'text', text } }],
})

describe('update kind predicates', () => {
  it('classifies text, thought, tool call, and tool call update', () => {
    expect(isTextChunk(msg('a'))).toBe(true)
    expect(isThoughtChunk(msg('a'))).toBe(false)
    expect(isThoughtChunk(thought('a'))).toBe(true)
    expect(isTextChunk(thought('a'))).toBe(false)
    expect(isToolCall(toolCall('c1', 'Bash'))).toBe(true)
    expect(isToolCall(toolStream('c1', 'in_progress', ''))).toBe(false)
    expect(isToolCallUpdate(toolStream('c1', 'in_progress', 'x'))).toBe(true)
    expect(isToolCallUpdate(msg('a'))).toBe(false)
  })
})

describe('chunkDelta', () => {
  it('extracts the text delta from a text chunk', () => {
    expect(chunkDelta(msg('hi'))).toBe('hi')
  })

  it('returns empty for a non-text content block or missing content', () => {
    expect(chunkDelta({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } })).toBe('')
    expect(chunkDelta({ sessionUpdate: 'agent_message_chunk' })).toBe('')
  })
})

describe('tool identity', () => {
  it('reads the tool call id and name', () => {
    expect(toolCallIdOf(toolCall('0:call_1', 'Bash'))).toBe('0:call_1')
    expect(toolCallName(toolCall('0:call_1', 'Bash'))).toBe('Bash')
  })

  it('classifies stream statuses as streaming vs settled and error', () => {
    expect(isToolSettledStatus('in_progress')).toBe(false)
    expect(isToolSettledStatus('pending')).toBe(false)
    expect(isToolSettledStatus('running')).toBe(false)
    expect(isToolSettledStatus('complete')).toBe(true)
    expect(isToolSettledStatus('failed')).toBe(true)
    // Measured on MiniMax 1.1.56: progress frames omit the field entirely.
    expect(isToolSettledStatus(undefined)).toBe(false)
    expect(isToolSettledStatus('')).toBe(false)
    // An unknown status is not a terminal one; only the protocol's own values are.
    expect(isToolSettledStatus('weird')).toBe(false)
    expect(isToolSettledStatus('cancelled')).toBe(true)
    expect(isToolErrorStatus('failed')).toBe(true)
    expect(isToolErrorStatus('error')).toBe(true)
    expect(isToolErrorStatus('denied')).toBe(true)
    expect(isToolErrorStatus('complete')).toBe(false)
  })
})

describe('toolContentText', () => {
  it('joins the nested content-text blocks', () => {
    const update = toolStream('c1', 'in_progress', 'a') as unknown as AcpToolCallStreamExt
    update.content = [
      { type: 'content', content: { type: 'text' as const, text: 'a' } },
      { type: 'content', content: { type: 'text' as const, text: 'b' } },
    ]
    expect(toolContentText(update)).toBe('ab')
  })

  it('returns undefined for an update with no content field (nothing to replace)', () => {
    const absent = { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' } as unknown as AcpToolCallStreamExt
    expect(toolContentText(absent)).toBeUndefined()
  })

  it('reads MiniMax’s rawOutput content, in both block spellings', () => {
    const flat = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'TOOLPROBE' }] },
    } as unknown as AcpToolCallStreamExt
    expect(toolContentText(flat)).toBe('TOOLPROBE')
    const nested = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      rawOutput: { content: [{ type: 'content', content: { type: 'text', text: 'nested' } }] },
    } as unknown as AcpToolCallStreamExt
    expect(toolContentText(nested)).toBe('nested')
  })

  it('falls back to a rawOutput string or stdout', () => {
    const rawString = {
      sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'plain',
    } as unknown as AcpToolCallStreamExt
    expect(toolContentText(rawString)).toBe('plain')
    const stdout = {
      sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { stdout: 'out' },
    } as unknown as AcpToolCallStreamExt
    expect(toolContentText(stdout)).toBe('out')
    const neither = {
      sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { details: {} },
    } as unknown as AcpToolCallStreamExt
    expect(toolContentText(neither)).toBeUndefined()
  })

  it('returns undefined for a null rawOutput and skips malformed blocks', () => {
    const nullRaw = {
      sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: null,
    } as unknown as AcpToolCallStreamExt
    expect(toolContentText(nullRaw)).toBeUndefined()
    const malformed = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [
        null,
        'not a block',
        { type: 'text', text: 42 },
        { type: 'content', content: { type: 'image', data: 'x' } },
        { type: 'content', content: { type: 'text', text: 42 } },
        { type: 'text', text: 'ok' },
      ],
    } as unknown as AcpToolCallStreamExt
    expect(toolContentText(malformed)).toBe('ok')
  })

  it('prefers the direct content field when both are present', () => {
    const both = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'direct' } }],
      rawOutput: { content: [{ type: 'text', text: 'raw' }] },
    } as unknown as AcpToolCallStreamExt
    expect(toolContentText(both)).toBe('direct')
  })

  it('returns empty for empty content and for non-matching blocks', () => {
    const empty = toolStream('c1', 'in_progress', '') as unknown as AcpToolCallStreamExt
    empty.content = []
    expect(toolContentText(empty)).toBe('')
    const update = toolStream('c1', 'in_progress', '') as unknown as AcpToolCallStreamExt
    update.content = [
      { type: 'content', content: { type: 'image' as never } } as never,
      { type: 'not-content', content: { type: 'text', text: 'x' } } as never,
    ] as never
    expect(toolContentText(update)).toBe('')
  })
})

describe('toolRawInput', () => {
  it('serializes the parsed input object the update carries', () => {
    const update = toolStream('c1', 'in_progress', 'x') as unknown as AcpToolCallStreamExt
    update.rawInput = { command: 'ls' }
    expect(toolRawInput(update)).toBe('{"command":"ls"}')
  })

  it('passes a wire string through unchanged', () => {
    const update = toolStream('c1', 'in_progress', 'x') as unknown as AcpToolCallStreamExt
    update.rawInput = '{"command":"ls"}'
    expect(toolRawInput(update)).toBe('{"command":"ls"}')
  })

  it('returns undefined while the frame carries no input', () => {
    // The announcement never carries it — this is the shape the driver waits on.
    expect(toolRawInput(toolCall('c1', 'Bash') as AcpToolCallStreamExt)).toBeUndefined()
  })
})

describe('toolResult', () => {
  it('projects a successful tool result with the joined text', () => {
    const result = toolResult('0:call_1', 'Command executed successfully.', false)
    expect(toolResultView(result)).toMatchObject({
      role: toolResultRole(),
      toolCallId: '0:call_1',
      content: [{ type: 'text', text: 'Command executed successfully.' }],
      isError: false,
    })
  })

  it('marks an error result and defaults empty text to a placeholder', () => {
    expect(toolResultView(toolResult('0:call_1', '', true)))
      .toMatchObject({ role: toolResultRole(), isError: true, content: [{ type: 'text', text: '(no content)' }] })
  })
})
