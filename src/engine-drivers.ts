/**
 * The node-side half of the engine registry: which class drives which engine.
 *
 * {@link ENGINE_REGISTRY} (`./engine-registry.ts`) declares what every engine
 * IS, in data the browser bundle can also read. This module is the one place
 * that has to import the driver classes themselves, and it is deliberately
 * node-only: `./client/**` must never reach it, or the browser artifact would
 * pull `node:fs`, the SDKs and every engine driver with it.
 *
 * The two are kept in step by the type system rather than by discipline:
 * {@link ENGINE_DRIVER_FACTORIES} is a total `Record` over
 * {@link HostedEngineId}, so adding an id to the registry without adding its
 * driver fails the build. The reverse (a driver with no id) cannot happen —
 * the record's keys are the ids.
 *
 * ## What a driver factory receives
 *
 * Every engine is constructed from the SAME composition-entry config object
 * (`Config` in `./index.ts`), because the entry is an engine-agnostic superset:
 * any session may select any engine at any moment, so the entry carries every
 * engine's knobs at once. Each factory picks the fields its engine owns and
 * drops the rest — which is why the per-engine config projections live here
 * rather than in the entry's schema.
 *
 * @module dsh-loop-engine/engine-drivers
 */

import type { Context } from '@deepseek-ai/cordis'
import { ClaudeCodeLoop } from './engine-claude/loop.ts'
import { CodexLoop } from './engine-codex/loop.ts'
import { PiLoop } from './engine-pi/loop.ts'
import { KimiLoop } from './engine-kimi/loop.ts'
import { AgyLoop } from './engine-agy/loop.ts'
import { ZcodeLoop } from './engine-zcode/loop.ts'
import { QoderclicnLoop } from './engine-qoderclicn/loop.ts'
import { HermesLoop } from './engine-hermes/loop.ts'
import type { ClaudeCodePermissionMode } from './engine-claude/types.ts'
import type { CodexApprovalPolicy, CodexSandboxMode } from './engine-codex/types.ts'
import type { PiSandboxMode } from './engine-pi/types.ts'
import type { AgyEffort, AgyMode } from './engine-agy/process.ts'
import type { HostedEngineId } from './engine-registry.ts'
import type { RouterEngine } from './router-loop.ts'

/**
 * The engine knobs one composition entry carries, as this module reads them.
 *
 * Declared structurally rather than imported from `./index.ts` so the
 * dependency runs one way: `index.ts` imports the dispatch table, and the table
 * does not import the entry's schema. Every field is optional, matching the
 * entry's permissive schema — a deployment configures only the engines it uses.
 */
export interface EngineDriverConfig {
  /** Claude Code: pinned permission mode (overrides the session's own knobs). */
  permissionMode?: ClaudeCodePermissionMode
  /** Explicit environment entries layered over the credential-scrubbed parent environment. */
  env?: Record<string, string>
  /** Fallback model, used when the session selects none. */
  model?: string
  /** Claude Code: grace for process-tree termination. */
  disposeGraceMs?: number
  /** Claude Code: cap on agent turns per query. */
  maxTurns?: number
  /** Codex / Pi: pinned sandbox mode. */
  sandboxMode?: CodexSandboxMode | PiSandboxMode
  /** Codex: pinned approval policy. */
  approvalPolicy?: CodexApprovalPolicy
  /** Pi: pinned LLM provider. */
  piProvider?: string
  /** Pi: thinking/reasoning level. */
  piThinking?: string
  /** Idle window before a persistent child is shut down (Kimi, Codex). */
  childIdleMs?: number
  /** Antigravity: pinned execution mode (`--mode`). */
  agyMode?: AgyMode
  /** Antigravity: pinned reasoning effort (`--effort`). */
  agyEffort?: AgyEffort
  /** Antigravity: pinned terminal-restriction flag. */
  agySandbox?: boolean
  /** Qoder CN: pinned permission mode, overriding the session's dsh knobs. */
  qoderPermissionMode?: string
  /** Hermes: pinned reasoning level (`--reasoning`). */
  hermesReasoning?: string
  /**
   * Per-engine executable overrides, keyed by each descriptor's
   * {@link EngineDescriptor.binConfigKey}.
   *
   * One open map rather than a field per engine: the registry already names the
   * key each engine reads, so a new engine adds no schema field and no
   * projection branch — it reads `config.bins?.[descriptor.binConfigKey]`.
   */
  bins?: Readonly<Record<string, string>>
}

/** Builds one engine's driver runtime. */
export type EngineDriverFactory = (ctx: Context, config: EngineDriverConfig) => RouterEngine

/**
 * Resolve the executable a deployment pinned for one engine, or `undefined` to
 * let the engine's own resolver decide.
 * @param engine - the engine whose executable is being resolved.
 * @param config - the composition entry's knobs.
 * @param binConfigKey - the descriptor's key into `config.bins`.
 * @returns the pinned executable, or undefined when the deployment pinned none.
 */
function pinnedBin(
  config: EngineDriverConfig,
  binConfigKey: string | undefined,
): string | undefined {
  if (binConfigKey === undefined) return undefined
  const value = config.bins?.[binConfigKey]
  return value === undefined || value === '' ? undefined : value
}

/**
 * One factory per hosted engine.
 *
 * Total over {@link HostedEngineId} by type: the compiler refuses a missing row,
 * which is what makes "add an id to the registry" an incomplete change until the
 * driver is wired too.
 */
export const ENGINE_DRIVER_FACTORIES: Readonly<Record<HostedEngineId, EngineDriverFactory>> = {
  'claude-code': (ctx, config) => {
    const bin = pinnedBin(config, 'claudeBin')
    return new ClaudeCodeLoop(ctx, {
      ...config.permissionMode === undefined ? {} : { permissionMode: config.permissionMode },
      ...config.env === undefined ? {} : { env: config.env },
      ...config.model === undefined ? {} : { model: config.model },
      ...config.disposeGraceMs === undefined ? {} : { disposeGraceMs: config.disposeGraceMs },
      ...config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns },
      ...bin === undefined ? {} : { bin },
    })
  },

  codex: (ctx, config) => {
    const bin = pinnedBin(config, 'codexBin')
    // Codex's sandbox vocabulary is the one the registry declares for it; the
    // entry's field is shared with Pi, whose modes are the same three words.
    const sandboxMode = config.sandboxMode as CodexSandboxMode | undefined
    return new CodexLoop(ctx, {
      ...sandboxMode === undefined ? {} : { sandboxMode },
      ...config.approvalPolicy === undefined ? {} : { approvalPolicy: config.approvalPolicy },
      ...config.env === undefined ? {} : { env: config.env },
      ...config.model === undefined ? {} : { model: config.model },
      ...config.childIdleMs === undefined ? {} : { childIdleMs: config.childIdleMs },
      ...bin === undefined ? {} : { bin },
    })
  },

  pi: (ctx, config) => {
    const bin = pinnedBin(config, 'piBin')
    const sandboxMode = config.sandboxMode as PiSandboxMode | undefined
    return new PiLoop(ctx, {
      ...config.piProvider === undefined ? {} : { provider: config.piProvider },
      ...config.model === undefined ? {} : { model: config.model },
      ...config.piThinking === undefined ? {} : { thinkingLevel: config.piThinking },
      ...config.env === undefined ? {} : { env: config.env },
      ...sandboxMode === undefined ? {} : { sandboxMode },
      ...bin === undefined ? {} : { bin },
    })
  },

  kimi: (ctx, config) => {
    const bin = pinnedBin(config, 'kimiBin')
    return new KimiLoop(ctx, {
      ...config.model === undefined ? {} : { model: config.model },
      ...config.env === undefined ? {} : { env: config.env },
      ...bin === undefined ? {} : { bin },
      ...config.childIdleMs === undefined ? {} : { childIdleMs: config.childIdleMs },
    })
  },

  agy: (ctx, config) => {
    const bin = pinnedBin(config, 'agyBin')
    return new AgyLoop(ctx, {
      ...config.model === undefined ? {} : { model: config.model },
      ...config.env === undefined ? {} : { env: config.env },
      ...bin === undefined ? {} : { bin },
      ...config.agyMode === undefined ? {} : { mode: config.agyMode },
      ...config.agyEffort === undefined ? {} : { effort: config.agyEffort },
      ...config.agySandbox === undefined ? {} : { sandbox: config.agySandbox },
    })
  },

  zcode: (ctx, config) => {
    const bin = pinnedBin(config, 'zcodeBin')
    return new ZcodeLoop(ctx, {
      ...config.model === undefined ? {} : { model: config.model },
      ...config.env === undefined ? {} : { env: config.env },
      ...bin === undefined ? {} : { bin },
    })
  },

  qoderclicn: (ctx, config) => {
    const bin = pinnedBin(config, 'qoderclicnBin')
    return new QoderclicnLoop(ctx, {
      ...config.model === undefined ? {} : { model: config.model },
      ...config.env === undefined ? {} : { env: config.env },
      ...bin === undefined ? {} : { bin },
      ...config.qoderPermissionMode === undefined ? {} : { permissionMode: config.qoderPermissionMode },
    })
  },

  hermes: (ctx, config) => {
    const bin = pinnedBin(config, 'hermesBin')
    return new HermesLoop(ctx, {
      ...config.model === undefined ? {} : { model: config.model },
      ...config.env === undefined ? {} : { env: config.env },
      ...bin === undefined ? {} : { bin },
      ...config.hermesReasoning === undefined ? {} : { reasoning: config.hermesReasoning },
    })
  },




}

/**
 * Build one hosted engine's driver runtime.
 *
 * The one dispatch point the router calls, replacing the per-engine `switch`
 * that used to live in `./index.ts`: adding an engine is now a registry row plus
 * a factory row, and the `switch` that would have needed a new `case` — and a
 * new `default` to keep TypeScript quiet — is gone.
 * @param engine - the engine to build.
 * @param ctx - the context the runtime's effects belong to.
 * @param config - the composition entry's engine knobs.
 * @returns the engine's driver runtime.
 */
export function buildEngineDriver(
  engine: HostedEngineId,
  ctx: Context,
  config: EngineDriverConfig,
): RouterEngine {
  return ENGINE_DRIVER_FACTORIES[engine](ctx, config)
}
