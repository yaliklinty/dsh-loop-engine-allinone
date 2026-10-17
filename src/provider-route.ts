/**
 * Hosted-engine provider route placeholder.
 *
 * Every hosted engine logs its sessions' request/header with ONE shared provider
 * label ({@link HOSTED_ROUTE_LABEL}, `external`) rather than a model endpoint the
 * harness llm registry serves — the engine owns its model natively. The web
 * host derives a session's model selection from that header and refuses a turn
 * whose provider no registered adapter serves, so without a placeholder route
 * the SECOND prompt of every hosted session fails with `model-unavailable`.
 *
 * One label for every hosted engine, because the browser model catalog is built
 * per Host GENERATION and does not require (or vary by) a Session
 * (`packages/api/session-controller/src/catalog.ts`). A per-engine label would
 * therefore show one provider group per engine in every session's menu at once —
 * four identical `default` entries — so they are collapsed into this one route.
 *
 * Serving the label is only half of it. The model menu renders the session's
 * selection through the catalog, and a provider group that advertises no models
 * is dropped (`packages/api/session-controller/src/catalog.ts`, non-empty
 * groups only) — leaving the seat to show the raw `provider/model` string, i.e.
 * a model that does not exist to any adapter. So the placeholder advertises
 * exactly ONE entry, {@link HOSTED_DEFAULT_MODEL}:
 * `{ provider: HOSTED_ROUTE_LABEL, id: 'default', name: 'default' }`. The id is
 * the same string every engine logs as its model label, which is what makes the
 * seat resolve the session's `(provider, model)` to this entry and render the
 * engine's own word for "whatever it decides" instead of a composite string
 * (see {@link HOSTED_DEFAULT_MODEL} for the host-side mechanism).
 *
 * The entry is not a model this plugin can serve: {@link HostedEngineRouteAdapter.stream}
 * fails loud, because a real model call reaching one of these routes means a
 * session the harness loop drives was handed an engine label — a wiring bug,
 * not a request. Two things keep that from happening: a session switched back
 * to `in-process` has the deployment default written into its log
 * (`model-selection-reset.ts`), and a session BUILT on `in-process` whose
 * selection is one of these labels has it replaced by the same authority before
 * the host installs it (same module, `guardFor`).
 *
 * @module dsh-loop-engine/provider-route
 */

import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { HOSTED_DEFAULT_MODEL, HOSTED_ROUTE_LABEL, HOSTED_ROUTE_NAME } from './agent-preset-ids.ts'
import { ENGINE_REGISTRY, HOSTED_ENGINE_IDS, type EngineDescriptor, type EngineModel } from './engine-registry.ts'
import type { HostedEngineId } from './settings.ts'

/**
 * Context window this plugin declares for the hosted route when a deployment
 * pins none: 262144 tokens (256 Ki).
 *
 * The number exists because dsh's own auto-compaction sizes its pressure
 * threshold from the routed model's declared capacity
 * (`packages/compaction/compaction-basic/src/config.ts` `resolveCompactSpec` —
 * `contextWindow * thresholdRatio`, ratio defaulting to `0.8`). A hosted engine
 * reports no capacity at all: its model lives inside its own child process, so
 * the placeholder route is the only place dsh can read one. 256 Ki is the round
 * window the hosted CLIs in use expose; a deployment whose engine window is
 * smaller, or whose engines differ, should set `engineContextWindow` to the
 * smallest window in use (see `src/index.ts`).
 */
export const DEFAULT_ENGINE_CONTEXT_WINDOW = 262144

/**
 * The input modalities this route's single entry declares: text AND image.
 *
 * Every hosted engine is handed the images of the step's own messages —
 * `pi`/`kimi` as bytes over their RPC/ACP channels, `codex` as a `localImage`
 * path the app-server opens itself, `claude-code` as base64 blocks appended to
 * the prompt's streaming input message (the prompt's image placeholder still
 * names the readable path; see `docs/driver-core.md` §2 and
 * `docs/engine-claude.md` §9.1). The capability
 * therefore belongs to the route, which is what the host asks about; which
 * shape of handover an engine gets is that engine's business, not the session's.
 */
export const HOSTED_MODEL_MODALITIES: readonly ModelModality[] = ['text', 'image']

/**
 * The provider route label one hosted engine logs into its sessions'
 * request/header.
 *
 * **Two kinds of label, on purpose.**
 *
 * An engine that declares its own model catalog (`descriptor.models`,
 * `engine-registry.ts`) gets a route of ITS OWN, named by its engine id. The
 * model menu then shows a group per such engine — `agy` holding
 * `default` plus Gemini/Claude ids — and picking one passes that id to the
 * engine.
 *
 * Every other engine keeps the shared {@link HOSTED_ROUTE_LABEL} (`external`)
 * with its single `default`. That is not a leftover: the browser model catalog
 * is built per Host GENERATION rather than per session
 * (`packages/api/session-controller/src/catalog.ts`), so a group per engine
 * would put eight identical `default` rows in every session's menu — the exact
 * noise the shared label exists to avoid. A group only earns its place in that
 * menu by carrying models the others do not.
 *
 * Both kinds stay registered, so a session logged either way keeps resolving.
 * @param engine - the hosted engine whose route label is asked for.
 * @returns that engine's route label.
 */
export function hostedRouteLabelOf(engine: HostedEngineId): string {
  // Read through the INTERFACE rather than the literal row: `ENGINE_REGISTRY` is
  // `as const satisfies`, so a row that declares no `models` does not carry the
  // key at all and a direct read would not type-check across the union.
  const descriptor: EngineDescriptor = ENGINE_REGISTRY[engine]
  return descriptor.models === undefined ? HOSTED_ROUTE_LABEL : engine
}

/**
 * The hosted engine whose own route a provider label names, if any.
 *
 * The inverse of the per-engine half of {@link hostedRouteLabelOf}, for the
 * places that must attribute a selection to an engine — chiefly the refusal a
 * driver owes when a session picks a model belonging to a DIFFERENT engine.
 * @param provider - a provider label from a selection.
 * @returns the engine that label belongs to, or undefined for the shared route
 *   and for anything that is not one of this plugin's routes.
 */
export function hostedEngineOfRouteLabel(provider: string): HostedEngineId | undefined {
  const descriptor = (ENGINE_REGISTRY as Readonly<Record<string, { models?: readonly EngineModel[] }>>)[provider]
  return descriptor !== undefined && descriptor.models !== undefined ? provider as HostedEngineId : undefined
}

/**
 * Every provider label this plugin has ever logged, for the membership tests the
 * plugin makes.
 *
 * The shared route ({@link HOSTED_ROUTE_LABEL}) plus every hosted engine id.
 * The engine ids cover two cases at once: an engine that declares a model
 * catalog owns a route named by its id (`hostedRouteLabelOf`), and an earlier
 * build logged bare engine ids as per-engine route labels. Both must be
 * recognized as "hosted", because that is what makes the reset guard rewrite
 * such a session's seat before the host would refuse its turn with
 * `model-unavailable` (see {@link isHostedProviderRoute}).
 */
const HOSTED_PROVIDER_LABELS: readonly string[] = [HOSTED_ROUTE_LABEL, ...HOSTED_ENGINE_IDS]

/**
 * Whether a provider is one of this plugin's hosted engine route labels — a
 * label some hosted engine logs (now, or in an earlier build), which no adapter
 * serves a real model on.
 *
 * The OLD four per-engine labels are members on purpose, even though only
 * {@link HOSTED_ROUTE_LABEL} is registered. A pre-existing session's header
 * still names one of them; treating only the current label as hosted would let
 * such a session keep the stale selection, and the host — which finds no
 * adapter serving `kimi` any more — would refuse its next turn
 * (`model-unavailable`). Membership here is what lets `model-selection-reset`
 * rewrite the seat to `external/default` (or the deployment default) first.
 * @param provider - the provider of any selection, header, or default.
 * @returns whether that provider is a hosted engine's route label.
 */
export function isHostedProviderRoute(provider: string): boolean {
  return HOSTED_PROVIDER_LABELS.includes(provider)
}

/**
 * Placeholder adapter serving the one hosted engine provider route label.
 *
 * It advertises the single menu entry ({@link HOSTED_DEFAULT_MODEL}) so the
 * model seat can name the session's selection, carries the route's display name
 * ({@link HOSTED_ROUTE_NAME}) so the catalog's provider group is labelled
 * `external`, and {@link stream} fails loud: a call reaching it means a real model
 * query was routed to an engine that owns its model natively — a wiring bug, not
 * a request to serve.
 *
 * It also DECLARES a context window for the route ({@link resolveModel}): the
 * window is what dsh's auto-compaction measures its pressure threshold against,
 * and a hosted engine reports no capacity of its own, so without one the hosted
 * session never compacts.
 */
export class HostedEngineRouteAdapter extends LlmAdapter {
  /**
   * Capacity this route declares, normalized at construction.
   *
   * A deployment knob rather than a constant because the engines' real windows
   * differ; the adapter only guarantees the value the registry's validation
   * accepts (a positive integer), so a non-positive or non-integer wire value
   * cannot reach the compaction path as a nonsense window.
   */
  private readonly contextWindow: number

  /**
   * @param contextWindow - declared context capacity in tokens. A value that is
   *   not a positive integer (absent included) falls back to
   *   {@link DEFAULT_ENGINE_CONTEXT_WINDOW}.
   */
  /**
   * The provider label this adapter was registered for, echoed by every method
   * (the registry rejects an identity mismatch).
   */
  private readonly label: string
  /**
   * The engine-native models this route advertises, beyond `default`.
   *
   * Empty for the shared `external` route: an engine with no declared catalog
   * has nothing to add to "the engine decides".
   */
  private readonly models: readonly EngineModel[]

  /**
   * The name this route's group shows in the model menu.
   *
   * A separate field from {@link label}: the label is the WIRE value (the engine
   * id, which the registry compares against the registration), while this is what
   * a human reads. Conflating them would put `agy` in the menu instead of
   * `Antigravity`.
   */
  private readonly displayName: string

  /**
   * @param contextWindow - declared context capacity in tokens.
   * @param label - the provider label this adapter serves (a wire value).
   * @param models - the engine-native models to advertise beside `default`.
   * @param displayName - the group name shown in the model menu.
   */
  constructor(
    contextWindow?: number,
    label: string = HOSTED_ROUTE_LABEL,
    models: readonly EngineModel[] = [],
    displayName: string = HOSTED_ROUTE_NAME,
  ) {
    super()
    this.contextWindow = contextWindow !== undefined && Number.isInteger(contextWindow) && contextWindow > 0
      ? contextWindow
      : DEFAULT_ENGINE_CONTEXT_WINDOW
    this.label = label
    this.models = models
    this.displayName = displayName
  }

  /**
   * Name the route's one entry.
   *
   * `id` must equal the provider the adapter was registered for (the registry
   * rejects a mismatch — `packages/llm/llm/src/index.ts` `prepareRoutes`), so it
   * is echoed back; `name` is the one localized string the catalog carries.
   * @param provider - the route this adapter is registered for.
   * @returns the route's display metadata.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    // The shared route keeps its fixed name; an engine's own route is named by
    // the engine's display label, so the menu reads "Antigravity" rather than a
    // bare id.
    return {
      id: provider,
      name: provider === HOSTED_ROUTE_LABEL ? HOSTED_ROUTE_NAME : this.displayName,
    }
  }

  /**
   * Advertise the route's single entry.
   *
   * The id is the model label the engine logs, so the picker resolves a hosted
   * session's selection to this entry (and highlights its row) rather than
   * falling through to the raw composite string; the name is the same word,
   * rendered as-is.
   *
   * {@link HOSTED_MODEL_MODALITIES} is declared, not left absent, because the
   * host reads it as a capability: `packages/api/session-controller/src/commands.ts`
   * refuses a prompt carrying an image when the session's model declares
   * modalities that exclude `image`, and `LlmModelInfo` documents an absent
   * field as UNKNOWN. A hosted session's fate for an attached image therefore
   * has to be something this plugin SAYS, not something a missing field happens
   * to allow — while a field this plugin omits, or the harness stops treating
   * as unknown, silently turns every hosted session image-blind.
   *
   * No capacity is declared here, because `LlmModelInfo` (the catalog shape this
   * method returns) has no context field at all; the window rides
   * {@link resolveModel}, the shape the harness asks about capacity through.
   * @returns the one entry this route advertises.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      {
        provider,
        id: HOSTED_DEFAULT_MODEL,
        name: HOSTED_DEFAULT_MODEL,
        inputModalities: HOSTED_MODEL_MODALITIES,
      },
      // The engine's own models, from its own subscription. Selecting one hands
      // its id to the engine; the plugin still serves no model on this route.
      ...this.models.map(model => ({
        provider,
        id: model.id,
        name: model.label,
        inputModalities: HOSTED_MODEL_MODALITIES,
      })),
    ])
  }

  /**
   * Resolve the route's one entry for the exact model label asked about, with
   * the context window dsh needs to size auto-compaction.
   *
   * The capacity rides HERE rather than on {@link listModels}' entry because the
   * two are different harness concepts: `LlmModelInfo` — what the catalog and
   * the model menu read — has no capacity field, while `LlmResolvedModelInfo` —
   * what `ctx.llm.resolveModelInfo` returns — carries the optional
   * `context: { contextWindow }`. dsh's compaction pressure path calls the
   * latter for the session's latest routed model
   * (`packages/compaction/compaction-basic/src/index.ts` `compactIfNeeded`) and
   * throws `TargetPressureConfigError` — swallowed into a one-time warning, so
   * compaction simply never fires — when it comes back without a window. A
   * hosted session's log therefore only stays bounded because this method
   * answers with one.
   *
   * `provider` and `id` are echoed exactly as asked: `normalizeModelInfo`
   * (`packages/llm/llm/src/index.ts`) rejects a result whose identity does not
   * match the query, and the model label a hosted session logged is the engine's
   * own word (`default`, or whatever a deployment pinned in `config.model`), not
   * always {@link HOSTED_DEFAULT_MODEL}. `name` is the same string, matching the
   * advertised entry, since `LlmModelInfo.name` is rendered verbatim.
   * @param provider - the route this adapter is registered for.
   * @param model - the exact model label the session's `request/header` logged.
   * @param _signal - unused; resolution is synchronous.
   * @returns the route's entry with its declared context window.
   */
  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: HOSTED_MODEL_MODALITIES,
      context: { contextWindow: this.contextWindow },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      `provider "${this.label}" is a hosted loop engine route, not a model endpoint`,
      'HOSTED_ENGINE_ROUTE',
    )
  }
}
