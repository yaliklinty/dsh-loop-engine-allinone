/**
 * The JSONL persistence backend, as a mountable Cordis plugin on every harness
 * line the suite runs against.
 *
 * The specs mount a real durability backend so their sessions own a real write
 * log. Which EXPORT carries the plugin, however, moved:
 *
 * - 0.1.5, 0.1.7 and 0.2.0 publish it as the module's `default` export.
 * - 0.2.1 publishes `{ name, apply, Config }` and drops the default, so
 *   `import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'`
 *   resolves to `undefined` there — cordis then rejects the mount with
 *   "invalid plugin, expect function or object with an \"apply\" method,
 *   received undefined".
 *
 * A spec that imports this module gets the same mountable plugin on all four
 * lines without branching, and the shape read happens once, at module load.
 *
 * @module tests/helpers/jsonl-persistence
 */

import type { Plugin } from '@deepseek-ai/cordis'
import * as jsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

/** The module namespace as an object with an optional default export. */
const namespace = jsonlPersistence as unknown as { default?: Plugin }

/**
 * The mountable plugin: the line's default export when it has one, otherwise
 * the namespace itself (which carries `name` and `apply` on 0.2.1+).
 */
const JsonlSessionPersistence: Plugin = namespace.default ?? (jsonlPersistence as unknown as Plugin)

export default JsonlSessionPersistence
