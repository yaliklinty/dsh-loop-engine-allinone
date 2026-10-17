/**
 * JSON-RPC 2.0 client for an ACP agent subprocess (Agent Client Protocol over
 * stdio), shared by every ACP engine driver.
 *
 * The driver hands the client a process handle carrying its stdin/stdout/stderr
 * (projected from the dsh subprocess seam). The client frames JSON-RPC 2.0
 * records on a bare `\n` (via a byte decoder, tolerating a trailing `\r`),
 * correlates request responses by `id`, dispatches every `session/update`
 * notification to a buffered event stream, and answers the reverse-RPC
 * `session/request_permission` requests the agent publishes. The child is
 * long-lived (one per factory) and stepped over via `newSession` + `prompt`.
 *
 * ## What is per-ENGINE here, and what is not
 *
 * The framing, correlation and dispatch are protocol facts and identical for
 * every ACP engine. Three things are NOT:
 *
 *   - the `protocolVersion` announced at `initialize`, which is a REGISTRY
 *     DECLARATION (`capabilities.acpProtocolVersion`, default 1) rather than a
 *     constant: three engines sharing one skeleton must not share one hardcoded
 *     version, which is the protocol-drift risk this parameter removes;
 *   - how a MODEL is selected (`session/set_model` on kimi,
 *     `session/set_config_option` on grok and MiniMax Code), exposed as separate
 *     methods so each driver calls the one its engine was measured to accept;
 *   - the engine's name in diagnostics, which travels as `label` so a message
 *     from a `grok agent stdio` child never says "kimi".
 *
 * @module dsh-loop-engine-allinone/driver-acp/client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { AcpProcess, AcpSpawnCapability, AcpSpawnSpec } from './transport.ts'
import { modelsFromAcpConfigOptions } from '../model-discovery.ts'
import {
  NO_CLIENT_CAPABILITIES,
  isCapabilityMethod,
  terminalCommandOf,
  terminalCwdOf,
  terminalEnvOf,
  type AcpClientCapabilities,
  type AcpReverseHandlers,
  type AcpTerminal,
} from './capabilities.ts'
import {
  isPermissionRequestFrame,
  isUpdateFrame,
  type AcpFrame,
  type AcpImageContent,
  type AcpPermissionOption,
  type AcpPermissionResponse,
  type AcpUpdate,
} from './types.ts'

/** How the client answers one `session/request_permission`. */
export type AcpPermissionHandler = (request: AcpFrame) => boolean | Promise<boolean>

/**
 * The answerable options of one `session/request_permission` frame. The wire is
 * untrusted, so entries without a usable `optionId` are dropped rather than
 * echoed back.
 * @param frame - the reverse-RPC request frame.
 * @returns the options the client may answer with.
 */
export function permissionOptionsOf(frame: AcpFrame): readonly AcpPermissionOption[] {
  const params = frame.params as { options?: unknown } | undefined
  if (params === undefined || !Array.isArray(params.options)) return []
  return params.options.filter((option): option is AcpPermissionOption =>
    typeof option === 'object' && option !== null && typeof (option as { optionId?: unknown }).optionId === 'string')
}

/**
 * Encode one approval decision as the ACP `RequestPermissionResponse` the agent
 * correlates against the options it advertised. The agent reads a terminal
 * *option*, never a boolean: an outcome it cannot resolve (or a response that
 * fails to parse at all) is reported to the model as a user rejection, so a
 * decision that no single option expresses becomes `cancelled` — the honest
 * "this client has no answer". Kimi re-uses this RPC for its question and
 * plan-review bridges, which offer one `allow_once` option per choice; picking
 * one of those would answer a question no human was asked, so any ambiguous
 * set (zero or several `allow_once`/`reject_once` candidates) cancels instead.
 * `allow_once` is preferred over `allow_always` because the decision is re-read
 * from the session knobs on every request: letting the agent cache a session
 * grant would outlive a mid-session switch back to `ask`.
 * @param approved - whether the driver approves the request.
 * @param options - the options the agent advertised for this request.
 * @returns the result payload to send back.
 */
export function permissionResponse(approved: boolean, options: readonly AcpPermissionOption[]): AcpPermissionResponse {
  const candidates = options.filter(option => option.kind === (approved ? 'allow_once' : 'reject_once'))
  const match = candidates.length === 1 ? candidates[0] : undefined
  if (match === undefined) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: match.optionId } }
}

/** Callback receiving every non-response event line. */
export type AcpUpdateHandler = (update: AcpUpdate) => void

/**
 * Per-engine facts the shared client needs, all of them data.
 *
 * Defaulted rather than required, so `new AcpClient(process)` keeps meaning
 * "kimi, protocol version 1" — which is what the existing callers and tests
 * construct.
 */
export interface AcpClientOptions {
  /**
   * The ACP protocol version this client announces at `initialize`.
   *
   * From the engine's registry row (`capabilities.acpProtocolVersion`), whose
   * documented default is 1. A caller that pins nothing gets 1 — the version
   * every engine on this fork's reference host was verified against.
   */
  readonly protocolVersion?: number
  /** The engine's name in diagnostics (`kimi`, `grok`, `minimaxcode`). */
  readonly label?: string
  /**
   * The reverse-RPC methods this client can answer, and how.
   *
   * Absent means "none": the client announces no client capabilities and answers
   * every reverse request with `methodNotFound`, which is what the kimi driver has
   * always done and remains a supported configuration. A driver that supplies
   * `spawnTerminal` gets the `terminal` capability announced for it — the
   * declaration is DERIVED from the handlers so the two cannot drift.
   */
  readonly handlers?: AcpReverseHandlers
}

/** Default spawn: launch the ACP child under the current node runtime, projecting a native child. */
function defaultSpawn(spec: AcpSpawnSpec): AcpProcess {
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return fromNativeChild(child)
}

/** Project a `node:child_process` child onto the ACP process transport. */
function fromNativeChild(child: ChildProcess): AcpProcess {
  // A ChildProcess has no seam `done`; reconcile the native close event into one.
  const done = Promise.withResolvers<unknown>()
  child.once('exit', () => done.resolve(undefined))
  child.once('error', done.reject)
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    done: done.promise,
    terminate: () => child.kill(),
  }
}

/**
 * ACP client over one agent child. Created once per driver scope and reused
 * across steps, matching the Pi RPC client's lifecycle.
 */
export class AcpClient {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly updateBuffer: AcpUpdate[] = []
  private updateWake: (() => void) | undefined
  private updateHandler: AcpUpdateHandler | undefined
  private permissionHandler: AcpPermissionHandler | undefined
  private sealed = false
  private nextId = 1
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  /** The protocol version this client announces (registry-declared, default 1). */
  private readonly protocolVersion: number
  /** The engine's name in diagnostics. */
  private readonly label: string
  /** What this client can answer, and how (see {@link AcpClientOptions.handlers}). */
  private readonly handlers: AcpReverseHandlers
  /** Every terminal this client owns, so a disposed client cannot leak a process. */
  private readonly terminals = new Map<string, AcpTerminal>()
  /**
   * The model catalog the agent published on its last `session/new`.
   *
   * Free discovery: the frame was already paid for by a session the user opened, so
   * keeping it costs nothing and spares the maintainer from re-declaring the list
   * every time the vendor ships a model. `undefined` means the agent published no
   * model option (every engine except the ACP ones that do).
   */
  private lastCatalog: readonly { readonly id: string, readonly label: string }[] | undefined
  /** Monotonic id source for the terminals the agent creates. */
  private nextTerminalId = 1

  /** Whether this client was sealed or its process exited. */
  get closed(): boolean {
    return this.sealed
  }

  /** Mount a client over an already-spawned ACP agent process. */
  constructor(private readonly process: AcpProcess, options: AcpClientOptions = {}) {
    this.protocolVersion = options.protocolVersion ?? 1
    this.label = options.label ?? 'kimi'
    this.handlers = options.handlers ?? {}
    this.process.stdout.on('data', (chunk) => this.feed(chunk))
    this.process.stderr.on('data', () => {
      // Diagnostics are drained through other seams; keeping this pipe flowing
      // prevents a talky child from blocking on a full stderr.
    })
    this.process.done.then(() => {
      this.sealed = true
      const error = new Error(`${this.label} acp process exited unexpectedly`)
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
      this.updateWake?.()
    }, () => {
      this.sealed = true
      this.updateWake?.()
    })
  }

  /**
   * Create a client, spawning the ACP child through the supplied capability (or
   * the default node spawn when none is given).
   * @param spec - the argv/cwd/env the child should run with.
   * @param spawn - optional process-spawn capability (the subprocess seam).
   * @param options - the engine's declared protocol version and diagnostic label.
   * @returns the connected client.
   */
  static create(spec: AcpSpawnSpec, spawn?: AcpSpawnCapability, options: AcpClientOptions = {}): AcpClient {
    const process = spawn === undefined ? defaultSpawn(spec) : spawn(spec)
    return new AcpClient(process, options)
  }

  /** Register the event dispatch handler. */
  onUpdate(handler: AcpUpdateHandler): void {
    this.updateHandler = handler
  }

  /** Register the permission-approval handler (reverse-RPC answers). */
  onPermission(handler: AcpPermissionHandler): void {
    this.permissionHandler = handler
  }

  /** Send one request and await the correlated response. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.sealed) return Promise.reject(new Error(`${this.label} acp client is sealed`))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /** Send a notification (no correlated response awaited). */
  notify(method: string, params: unknown): void {
    if (this.sealed) return
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /**
   * The client capabilities to announce, DERIVED from what this client can
   * actually answer.
   *
   * Declaring a capability is a promise an agent plans around, so this never
   * announces more than the handlers implement: no `spawnTerminal` means no
   * `terminal: true`, and no `readTextFile` means no `fs.readTextFile`. A client
   * built with no handlers announces nothing, which is the pre-bridge behavior.
   * @returns the capability block for `initialize`.
   */
  clientCapabilities(): AcpClientCapabilities {
    if (this.handlers.spawnTerminal === undefined && this.handlers.readTextFile === undefined) {
      return NO_CLIENT_CAPABILITIES
    }
    return {
      fs: {
        readTextFile: this.handlers.readTextFile !== undefined,
        // Writes are deliberately not bridged: an agent that can write files
        // behind dsh's back would defeat the edit path's own policy, and no
        // measured engine has asked for one.
        writeTextFile: false,
      },
      terminal: this.handlers.spawnTerminal !== undefined,
    }
  }

  /**
   * Open the protocol handshake, announcing the engine's DECLARED protocol
   * version and the capabilities this client can honour.
   * @returns the agent's `initialize` result.
   */
  initialize(): Promise<unknown> {
    return this.request('initialize', {
      protocolVersion: this.protocolVersion,
      clientCapabilities: this.clientCapabilities(),
      clientInfo: { name: 'dsh-loop-engine-allinone', version: '1.0.0' },
    })
  }

  /**
   * Authenticate with one of the methods the agent advertised at `initialize`.
   *
   * Part of the ACP flow rather than an engine extension: an agent that requires
   * authentication refuses `session/new` until the client answers with the method
   * id it published (`grok agent stdio` does exactly that — measured on this
   * host; reproduce it with `scripts/probe/acp-handshake.mjs`).
   * @param methodId - one `authMethods[].id` from the initialize result.
   * @returns the agent's response to `authenticate`.
   */
  authenticate(methodId: string): Promise<unknown> {
    return this.request('authenticate', { methodId })
  }

  /**
   * Start a fresh ACP session and resolve to its session id.
   * @param cwd - the session's working directory.
   * @param extra - engine-specific `session/new` params (grok's `_meta`, for
   *   example), merged over the two every engine takes.
   * @returns the new session id.
   */
  async newSession(cwd: string, extra: Record<string, unknown> = {}): Promise<string> {
    const result = (await this.request('session/new', { cwd, mcpServers: [], ...extra })) as {
      sessionId?: string
      configOptions?: unknown
    }
    const sessionId = result?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`${this.label} acp session/new returned no session id`)
    }
    // Kept for the model menu: this frame already carried the catalog, so reading it
    // here costs nothing (see `model-discovery.ts` for why that distinction matters).
    const discovered = modelsFromAcpConfigOptions(result.configOptions)
    if (discovered !== undefined) this.lastCatalog = discovered
    return sessionId
  }

  /**
   * The model catalog this agent published on its last `session/new`, if any.
   *
   * Empty until the first session is opened, which is the honest state: the plugin
   * does not know the catalog before an engine has been asked.
   * @returns the discovered models, or undefined when the agent published none.
   */
  discoveredModels(): readonly { readonly id: string, readonly label: string }[] | undefined {
    return this.lastCatalog
  }

  /**
   * Load (resume) an existing ACP session by id.
   *
   * Measured: `session/load` is accepted by MiniMax Code and advertised by grok
   * (both answer `loadSession: true`). The driver itself replays the durable
   * transcript and opens a fresh ACP session per step, so this exists for the
   * probe and for a deployment that later wants engine-side session resume.
   * @param sessionId - the session to load.
   * @param cwd - the session's working directory.
   * @returns the agent's response to `session/load`.
   */
  loadSession(sessionId: string, cwd: string): Promise<unknown> {
    return this.request('session/load', { sessionId, cwd, mcpServers: [] })
  }

  /**
   * Select a session config option with the BARE value ACP's second-generation
   * schema takes (`session/set_config_option` with `value: 'x'`).
   *
   * Measured on MiniMax Code 0.6.12: both `model` and `permissionMode` accept
   * this spelling and answer `-32602 Invalid params` to the `{ value }` wrapper.
   * @param sessionId - the ACP session the option applies to.
   * @param configId - the option's id, as `session/new` advertised it.
   * @param value - the new value (a string id, or a boolean for a boolean option).
   * @returns the agent's response, which carries the updated option list.
   */
  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<unknown> {
    return this.request('session/set_config_option', { sessionId, configId, value })
  }

  /**
   * Select a session config option with the `{ value }` WRAPPER spelling, which
   * Grok's own documentation shows.
   *
   * Its own method because the two spellings are mutually exclusive on the wire:
   * an engine accepts one and rejects the other with `-32602 Invalid params`, so
   * a driver tries the documented one and falls back — never a guess baked into
   * a single call.
   * @param sessionId - the ACP session the option applies to.
   * @param configId - the option's id.
   * @param value - the new string value.
   * @returns the agent's response.
   */
  setConfigOptionValue(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.request('session/set_config_option', { sessionId, configId, value: { value } })
  }

  /**
   * Switch the session's ACP MODE (`session/new` answers with `modes`).
   *
   * MiniMax Code advertises `default` and `plan` and accepts this call
   * (measured). It is NOT the tool-permission switch — that is the engine's
   * `permissionMode` config option — so the driver keeps the two apart.
   * @param sessionId - the ACP session.
   * @param modeId - one of the advertised mode ids.
   * @returns the agent's response to `session/set_mode`.
   */
  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request('session/set_mode', { sessionId, modeId })
  }

  /**
   * Select the model for one ACP session. The agent answers with an error frame
   * when it cannot serve the id, and {@link request} rejects on that frame — so
   * an engine that refuses the model fails the step loud rather than silently
   * running its own default.
   * @param sessionId - the ACP session the model applies to.
   * @param modelId - the model id to select.
   * @returns the agent's response to `session/set_model`.
   */
  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.request('session/set_model', { sessionId, modelId })
  }

  /**
   * Prompt the agent in a session and resolve when the turn completes.
   * @param sessionId - the ACP session to prompt.
   * @param text - the serialized transcript, or a bare slash command.
   * @param images - image blocks to carry after the text block; omitted or
   *   empty leaves the request exactly the text-only shape.
   * @returns the agent's response to `session/prompt`.
   */
  prompt(sessionId: string, text: string, images: readonly AcpImageContent[] = []): Promise<unknown> {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }, ...images] })
  }

  /** Cancel the active turn in a session (fire-and-forget). */
  cancel(sessionId: string): void {
    this.request('session/cancel', { sessionId }).catch(() => undefined)
  }

  /**
   * Answer a pending `session/request_permission`.
   * @param id - the reverse-RPC request id.
   * @param response - the ACP outcome to answer with.
   */
  respondPermission(id: number, response: AcpPermissionResponse): void {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: response })}\n`)
  }

  /** Consume every buffered update as an async generator. */
  async *updates(): AsyncGenerator<AcpUpdate, void, void> {
    while (true) {
      if (this.updateBuffer.length > 0) {
        yield this.updateBuffer.shift()!
        continue
      }
      if (this.sealed) return
      await new Promise<void>((resolve) => { this.updateWake = resolve })
      this.updateWake = undefined
    }
  }

  /** Seal the client and request child termination. */
  dispose(): void {
    if (this.sealed) return
    this.sealed = true
    // Every terminal this client owns is stopped here: an agent that never
    // released one must not leave a command running after the driver is gone.
    for (const terminal of this.terminals.values()) terminal.release()
    this.terminals.clear()
    this.process.terminate()
    const error = new Error(`${this.label} acp client is sealed`)
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
    this.updateWake?.()
  }

  private feed(chunk: Buffer | string): void {
    if (this.sealed) return
    const text = typeof chunk === 'string' ? this.buffer + chunk : this.buffer + this.decoder.write(chunk)
    this.buffer = text
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) break
      let line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.dispatch(line)
    }
  }

  /** Dispatch one parsed line: a response, an update notification, or a reverse-RPC request. */
  private dispatch(line: string): void {
    if (line.trim().length === 0) return
    let frame: AcpFrame
    try {
      frame = JSON.parse(line) as AcpFrame
    } catch {
      return // non-JSON line — ignore
    }
    // Reverse-RPC request needing an answer.
    if (isPermissionRequestFrame(frame)) {
      void this.handlePermission(frame.id, frame)
      return
    }
    // Response to one of our requests (result or error).
    if (typeof frame.id === 'number' && frame.method === undefined) {
      this.settle(frame)
      return
    }
    // session/update notification → buffered event stream.
    if (isUpdateFrame(frame)) {
      const update = frame.params.update as AcpUpdate
      this.updateHandler?.(update)
      this.updateBuffer.push(update)
      this.updateWake?.()
      return
    }
    // The measured client-side capabilities (fs, terminal) — see capabilities.ts.
    if (typeof frame.id === 'number' && typeof frame.method === 'string' && isCapabilityMethod(frame.method)) {
      void this.handleCapability(frame.id, frame.method, frame.params)
      return
    }
    // Unknown reverse-RPC → answer methodNotFound so the agent does not hang.
    if (typeof frame.id === 'number' && typeof frame.method === 'string') {
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Method not found' } })}\n`)
    }
  }

  private settle(frame: AcpFrame): void {
    const id = frame.id!
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (frame.error !== undefined) {
      pending.reject(new Error(frame.error.message ?? `${this.label} acp request failed`))
    } else {
      pending.resolve(frame.result)
    }
  }

  private async handlePermission(id: number, frame: AcpFrame): Promise<void> {
    const approved = this.permissionHandler === undefined ? false : await this.permissionHandler(frame)
    this.respondPermission(id, permissionResponse(approved, permissionOptionsOf(frame)))
  }

  /**
   * Answer one client-side capability request (`fs/read_text_file`, `terminal/*`).
   *
   * A capability this client did not announce is still answered `methodNotFound`
   * rather than guessed at: an agent that calls one anyway gets the same honest
   * refusal it would get from a client that never claimed it.
   * @param id - the reverse-RPC request id.
   * @param method - the ACP method name.
   * @param params - the request params.
   */
  private async handleCapability(id: number, method: string, params: unknown): Promise<void> {
    try {
      this.writeResult(id, await this.capabilityResult(method, params))
    } catch (error: unknown) {
      // A failed capability is reported to the AGENT, not thrown: the agent turns
      // it into a failed tool call, which is what the user should see.
      this.writeResult(id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Perform one capability request and return its ACP result payload.
   * @param method - the ACP method name.
   * @param params - the request params.
   * @returns the result object to send back.
   */
  private async capabilityResult(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file': {
        const read = this.handlers.readTextFile
        if (read === undefined) throw new Error('this client does not read files for the agent')
        const path = (params as { path?: unknown } | undefined)?.path
        if (typeof path !== 'string' || path === '') throw new Error('fs/read_text_file needs a path')
        return { content: await read(path) }
      }
      case 'terminal/create': {
        const spawn = this.handlers.spawnTerminal
        if (spawn === undefined) throw new Error('this client does not run commands for the agent')
        const command = terminalCommandOf(params)
        if (command === undefined) throw new Error('terminal/create needs a command')
        const cwd = terminalCwdOf(params)
        const env = terminalEnvOf(params)
        const terminal = await spawn(command, {
          ...cwd === undefined ? {} : { cwd },
          ...env === undefined ? {} : { env },
        })
        const terminalId = `term-${this.nextTerminalId++}`
        this.terminals.set(terminalId, terminal)
        return { terminalId }
      }
      case 'terminal/output': {
        const snapshot = this.terminalOf(params).snapshot()
        return {
          output: snapshot.output,
          truncated: false,
          ...snapshot.exited ? { exitStatus: { exitCode: snapshot.exitCode ?? 0 } } : {},
        }
      }
      case 'terminal/wait_for_exit': {
        const exit = await this.terminalOf(params).waitForExit()
        return { exitCode: exit.exitCode }
      }
      case 'terminal/release':
      case 'terminal/kill': {
        // ACP models a standalone kill as optional; this bridge's stop signal is
        // the release, so an engine that sends either one still stops its command.
        const terminalId = this.terminalIdOf(params)
        const terminal = this.terminals.get(terminalId)
        this.terminals.delete(terminalId)
        terminal?.release()
        return {}
      }
      default:
        throw new Error(`unsupported capability method: ${method}`)
    }
  }

  /**
   * The terminal id one capability frame names.
   * @param params - the request params.
   * @returns the id.
   */
  private terminalIdOf(params: unknown): string {
    const terminalId = (params as { terminalId?: unknown } | undefined)?.terminalId
    if (typeof terminalId !== 'string' || terminalId === '') throw new Error('the frame names no terminal')
    return terminalId
  }

  /**
   * The live terminal one capability frame names.
   * @param params - the request params.
   * @returns the terminal.
   */
  private terminalOf(params: unknown): AcpTerminal {
    const terminalId = this.terminalIdOf(params)
    const terminal = this.terminals.get(terminalId)
    if (terminal === undefined) throw new Error(`no terminal "${terminalId}" is open`)
    return terminal
  }

  /**
   * Write one reverse-RPC answer (result or error).
   * @param id - the request id being answered.
   * @param result - the result payload.
   * @param error - the error payload, when the request failed.
   */
  private writeResult(id: number, result: unknown, error?: { readonly code: number; readonly message: string }): void {
    if (this.sealed) return
    const frame = error === undefined
      ? { jsonrpc: '2.0', id, result }
      : { jsonrpc: '2.0', id, error }
    this.process.stdin.write(`${JSON.stringify(frame)}\n`)
  }
}
