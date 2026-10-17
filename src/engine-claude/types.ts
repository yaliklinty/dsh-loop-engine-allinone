/**
 * Public types of the Claude Code loop driver. Types only — no runtime code.
 *
 * @module dsh-loop-engine-allinone/engine-claude/types
 */

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/** Claude Code permission modes that never wait for a human response. */
export type ClaudeCodePermissionMode = Extract<PermissionMode,
  | 'dontAsk'
  | 'acceptEdits'
  | 'auto'
  | 'plan'
  | 'bypassPermissions'>

/** Driver configuration after defaults and load-time validation. */
export interface ResolvedConfig {
  /** Pinned native mode; `undefined` follows the session's dsh permission knobs per query. */
  readonly permissionMode: ClaudeCodePermissionMode | undefined
  readonly env: Record<string, string>
  readonly model: string | undefined
  readonly disposeGraceMs: number
  readonly maxTurns: number | undefined
  /**
   * An EXTERNAL Claude Code executable to run instead of the SDK's own bundled
   * one, or `undefined` to keep the bundled binary.
   *
   * Handed to the SDK's own `pathToClaudeCodeExecutable` option, which is a
   * public SDK surface — the SDK then launches this binary rather than the copy
   * it ships. The bundled copy keeps its own credential semantics, so a
   * deployment that pins a path must have signed that install in itself.
   */
  readonly bin: string | undefined
}
