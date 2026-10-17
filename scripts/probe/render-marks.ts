/**
 * Render the real `ENGINE_MARKS` table to a preview page.
 *
 * Imports the plugin's own data module (it has no runtime imports) so the page
 * shows exactly what the picker will draw — including Kimi's accent dot — rather
 * than a second copy that could drift.
 *
 * ```sh
 * node node_modules/tsx/dist/cli.mjs ../../data/render-marks.ts
 * ```
 */

import { writeFileSync } from 'node:fs'
import { ENGINE_MARKS } from '../../src/client/engine-marks.ts'
import { HOSTED_ENGINE_IDS } from '../../src/engine-registry.ts'

const ENGINE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code CLI',
  codex: 'Codex CLI',
  pi: 'Pi CLI',
  kimi: 'Kimi Code CLI',
  agy: 'Antigravity CLI',
  zcode: 'ZCode CLI',
  qoderclicn: 'Qoder CN CLI',
  hermes: 'Hermes Agent CLI',
}

/** One mark at a given size, exactly as the picker builds it. */
function mark(engine: keyof typeof ENGINE_MARKS, size: number, colour: string): string {
  const m = ENGINE_MARKS[engine]
  const accent = m.accent === undefined ? '' : `<path fill="${m.accent.fill}" d="${m.accent.d}"/>`
  return `<svg width=${size} height=${size} viewBox="${m.viewBox}" fill="none">`
    + `<path fill="${colour}" fill-rule="${m.fillRule ?? 'nonzero'}" d="${m.d}"/>${accent}</svg>`
}

// A menu-like list (light surface) plus a size sweep, which is what decides
// whether a mark survives at 16px.
const rows = HOSTED_ENGINE_IDS.map(engine => `<div class=row>`
  + `<span class=cell>${mark(engine, 16, '#1b1b1f')}</span>`
  + `<span class=label>${ENGINE_LABELS[engine] ?? engine}</span>`
  + `<span class=sizes>${[24, 32, 64].map(s => mark(engine, s, '#1b1b1f')).join('')}</span>`
  + `</div>`).join('')

const dark = HOSTED_ENGINE_IDS.map(engine => mark(engine, 20, '#e6e6e6')).join('')

writeFileSync(new URL('../../../../data/icon-preview/all-marks.html', import.meta.url), `<!doctype html><meta charset="utf-8">
<style>
 body{margin:0;font:13px system-ui;background:#fff;color:#1b1b1f}
 .list{padding:10px 16px}
 .row{display:flex;align-items:center;gap:12px;padding:6px 0}
 .cell{width:20px;display:inline-flex;justify-content:center}
 .label{width:170px}
 .sizes{display:inline-flex;gap:12px;align-items:center;opacity:.85}
 .dark{background:#1b1b1f;padding:14px 16px;display:flex;gap:18px;align-items:center}
</style>
<div class=list>${rows}</div>
<div class=dark>${dark}</div>`)
console.log('wrote data/icon-preview/all-marks.html')
