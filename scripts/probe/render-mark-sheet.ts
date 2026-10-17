/**
 * Render a decision sheet for ONE engine: the vendor artwork beside the traced
 * mark at the sizes the UI actually uses.
 *
 * Built for a question that needs a human's eyes ("does this silhouette read as
 * the brand?"), so it shows the original at full size next to the mark at 150,
 * 64, 32, 20 and 16 px, on both the light and dark surfaces.
 *
 * ```sh
 * node node_modules/tsx/dist/cli.mjs scripts/probe/render-mark-sheet.ts hermes <original.png>
 * ```
 */

import { writeFileSync } from 'node:fs'
import { ENGINE_MARKS } from '../../src/client/engine-marks.ts'
import type { HostedEngineId } from '../../src/engine-registry.ts'

const engine = (process.argv[2] ?? 'hermes') as HostedEngineId
const original = process.argv[3]
if (original === undefined) {
  console.error('usage: render-mark-sheet.ts <engine> <original.png>')
  process.exit(2)
}

const mark = ENGINE_MARKS[engine]
const accent = mark.accent === undefined ? '' : `<path fill="${mark.accent.fill}" d="${mark.accent.d}"/>`
const svg = (size: number, colour: string): string => `<svg width=${size} height=${size} viewBox="${mark.viewBox}" fill="none">`
  + `<path fill="${colour}" fill-rule="${mark.fillRule ?? 'nonzero'}" d="${mark.d}"/>${accent}</svg>`

const src = 'file:///' + original.split(String.fromCharCode(92)).join('/')
const sweep = (colour: string): string => [150, 64, 32, 20, 16].map(size => svg(size, colour)).join('')

writeFileSync(new URL(`../../../../data/icon-preview/${engine}-sheet.html`, import.meta.url), `<!doctype html><meta charset="utf-8">
<style>
 body{margin:0;font:13px system-ui}
 .band{display:flex;align-items:center;gap:26px;padding:16px 20px}
 .light{background:#fff;color:#1b1b1f}
 .dark{background:#1b1b1f;color:#e6e6e6}
 .cap{width:110px;opacity:.6}
 .pair{display:flex;gap:14px;align-items:center}
 .sizes{display:flex;gap:16px;align-items:center}
</style>
<div class="band light"><div class=cap>vendor artwork<br>+ traced mark</div>
  <div class=pair><img src="${src}" width=150 height=150>${svg(150, '#b45309')}</div></div>
<div class="band light"><div class=cap>sizes</div><div class=sizes>${sweep('#b45309')}</div></div>
<div class="band dark"><div class=cap>sizes (dark)</div><div class=sizes>${sweep('#d97706')}</div></div>`)
console.log(`wrote data/icon-preview/${engine}-sheet.html`)
