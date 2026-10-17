/**
 * One vector mark per hosted engine, as data.
 *
 * Data rather than JSX so it can be TESTED: the composer component cannot be
 * imported by the node test runner (it pulls
 * `@deepseek-ai/dsh-client-ui-primitives`, which resolves React through its own
 * package path rather than through the test alias), while this module imports
 * nothing at all. The regression it guards is concrete: every engine added to the
 * registry once fell through the mark switch's `default` arm and rendered the
 * harness's own DeepSeek fish beside its name.
 *
 * `in-process` is deliberately absent: it is the harness's own loop, it really is
 * DeepSeek's, and its mark is the `FishLogo` component rather than a path here.
 *
 * ## Where each mark comes from
 *
 * The four original engines carry their vendors' published paths. The four added
 * by the registry fork are traced or measured from the vendors' OWN artwork found
 * on this machine (see `data/trace-icons.py`, which records the source file and
 * the mask rule for each), because hand-drawing them produced shapes that did not
 * resemble the real marks.
 *
 * Each mark keeps its own `viewBox` and `fillRule`: they come from different
 * sources at different scales, and normalizing them would either distort the
 * vendor's proportions or force a re-trace for no gain.
 *
 * @module dsh-loop-engine/client/engine-marks
 */

import type { HostedEngineId } from '../engine-registry.ts'

/** One engine's mark, ready to render as a single `<path>`. */
export interface EngineMark {
  /** The source artwork's own coordinate system. */
  readonly viewBox: string
  /** Path data, in that coordinate system. */
  readonly d: string
  /**
   * `evenodd` for marks that rely on a counter (a hole); omitted for the default
   * `nonzero`, which is what a single solid path needs.
   */
  readonly fillRule?: 'nonzero' | 'evenodd'
  /**
   * A second subpath drawn in its OWN colour, for a mark whose brand identity is
   * two-tone (Kimi's white "K" carries a blue dot).
   *
   * Everything else stays `currentColor`, so the mark follows the menu's text
   * colour; an accent is the deliberate exception, and it exists rather than a
   * two-tone path because a single `d` can only be filled one way.
   */
  readonly accent?: { readonly d: string; readonly fill: string }
  /**
   * Draw the path as a STROKE rather than a fill, at this width in viewBox units.
   *
   * Some vendors publish the same mark twice: a solid app-tile version and a
   * monochrome outline one. Qoder is such a case, and the outline is the variant
   * that matches how the other marks read here.
   */
  readonly strokeWidth?: number
}

/**
 * How one mark should be painted, decided once.
 *
 * Both the component (JSX props) and the preview scripts (SVG attribute strings)
 * read this, because they each used to decide for themselves — and the preview
 * silently kept rendering a fill after Qoder's mark became a stroke, so the
 * picture I was judging by was no longer the picture the picker draws.
 */
export interface MarkPaint {
  /** Paint the path's interior, or trace its outline. */
  readonly mode: 'fill' | 'stroke'
  /** The paint colour. */
  readonly colour: string
  /** Stroke width in viewBox units; present only in `stroke` mode. */
  readonly width?: number
}

/**
 * Resolve how to paint one mark.
 * @param mark - the engine's mark.
 * @param colour - the colour the surface wants (`currentColor` resolves to it).
 * @returns the paint decision.
 */
export function markPaint(mark: EngineMark, colour: string): MarkPaint {
  return mark.strokeWidth === undefined
    ? { mode: 'fill', colour }
    : { mode: 'stroke', colour, width: mark.strokeWidth }
}

/** Every hosted engine's mark, keyed by engine id. */
export const ENGINE_MARKS: Readonly<Record<HostedEngineId, EngineMark>> = {
  "claude-code": {
    // Simple Icons' Claude Code mark (the vendor's own asterisk).
    fillRule: 'nonzero',
    viewBox: '0 0 24 24',
    d: 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z',
  },
  codex: {
    // OpenAI's blossom — codex has no distinct vector mark of its own.
    fillRule: 'nonzero',
    viewBox: '0 0 256 260',
    d: 'M239.183914,106.202783 C245.054304,88.5242096 243.02228,69.1733805 233.607599,53.0998864 C219.451678,28.4588021 190.999703,15.7836129 163.213007,21.739505 C147.554077,4.32145883 123.794909,-3.42398554 100.87901,1.41873898 C77.9631105,6.26146349 59.3690093,22.9572536 52.0959621,45.2214219 C33.8436494,48.9644867 18.0901721,60.392749 8.86672513,76.5818033 C-5.443491,101.182962 -2.19544431,132.215255 16.8986662,153.320094 C11.0060865,170.990656 13.0197283,190.343991 22.4238231,206.422991 C36.5975553,231.072344 65.0680342,243.746566 92.8695738,237.783372 C105.235639,251.708249 123.001113,259.630942 141.623968,259.52692 C170.105359,259.552169 195.337611,241.165718 204.037777,214.045661 C222.28734,210.296356 238.038489,198.869783 247.267014,182.68528 C261.404453,158.127515 258.142494,127.262775 239.183914,106.202783 L239.183914,106.202783 Z M141.623968,242.541207 C130.255682,242.559177 119.243876,238.574642 110.519381,231.286197 L112.054146,230.416496 L163.724595,200.590881 C166.340648,199.056444 167.954321,196.256818 167.970781,193.224005 L167.970781,120.373788 L189.815614,133.010026 C190.034132,133.121423 190.186235,133.330564 190.224885,133.572774 L190.224885,193.940229 C190.168603,220.758427 168.442166,242.484864 141.623968,242.541207 Z M37.1575749,197.93062 C31.456498,188.086359 29.4094818,176.546984 31.3766237,165.342426 L32.9113895,166.263285 L84.6329973,196.088901 C87.2389349,197.618207 90.4682717,197.618207 93.0742093,196.088901 L156.255402,159.663793 L156.255402,184.885111 C156.243557,185.149771 156.111725,185.394602 155.89729,185.550176 L103.561776,215.733903 C80.3054953,229.131632 50.5924954,221.165435 37.1575749,197.93062 Z M23.5493181,85.3811273 C29.2899861,75.4733097 38.3511911,67.9162648 49.1287482,64.0478825 L49.1287482,125.438515 C49.0891492,128.459425 50.6965386,131.262556 53.3237748,132.754232 L116.198014,169.025864 L94.3531808,181.662102 C94.1132325,181.789434 93.8257461,181.789434 93.5857979,181.662102 L41.3526015,151.529534 C18.1419426,138.076098 10.1817681,108.385562 23.5493181,85.125333 L23.5493181,85.3811273 Z M203.0146,127.075598 L139.935725,90.4458545 L161.7294,77.8607748 C161.969348,77.7334434 162.256834,77.7334434 162.496783,77.8607748 L214.729979,108.044502 C231.032329,117.451747 240.437294,135.426109 238.871504,154.182739 C237.305714,172.939368 225.050719,189.105572 207.414262,195.67963 L207.414262,134.288998 C207.322521,131.276867 205.650697,128.535853 203.0146,127.075598 Z M224.757116,94.3850867 L223.22235,93.4642272 L171.60306,63.3828173 C168.981293,61.8443751 165.732456,61.8443751 163.110689,63.3828173 L99.9806554,99.8079259 L99.9806554,74.5866077 C99.9533004,74.3254088 100.071095,74.0701869 100.287609,73.9215426 L152.520805,43.7889738 C168.863098,34.3743518 189.174256,35.2529043 204.642579,46.0434841 C220.110903,56.8340638 227.949269,75.5923959 224.757116,94.1804513 L224.757116,94.3850867 Z M88.0606409,139.097931 L66.2158076,126.512851 C65.9950399,126.379091 65.8450965,126.154176 65.8065367,125.898945 L65.8065367,65.684966 C65.8314495,46.8285367 76.7500605,29.6846032 93.8270852,21.6883055 C110.90411,13.6920079 131.063833,16.2835462 145.5632,28.338998 L144.028434,29.2086986 L92.3579852,59.0343142 C89.7419327,60.5687513 88.1282597,63.3683767 88.1117998,66.4011901 L88.0606409,139.097931 Z M99.9294965,113.5185 L128.06687,97.3011417 L156.255402,113.5185 L156.255402,145.953218 L128.169187,162.170577 L99.9806554,145.953218 L99.9294965,113.5185 Z',
  },
  pi: {
    // pi.dev's official logo.
    viewBox: '0 0 800 800',
    fillRule: 'evenodd',
    d: 'M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z M517.36 400H634.72V634.72H517.36Z',
  },
  kimi: {
    // Rebuilt from the vendor's app tile as the user pointed it out: a bold "K"
    // whose two arms are buried IN the stem (they must overlap it, or their
    // perpendicular end cuts leave a wedge-shaped notch at the joint), plus the
    // brand's blue dot as an accent.
    fillRule: 'nonzero',
    viewBox: '0 0 24 24',
    d: 'M4.6,3.9 L7.5,3.9 L7.5,20.1 L4.6,20.1ZM4.71974,10.6858 L14.7197,2.78575 L16.4803,5.01425 L6.48026,12.9142ZM6.48026,11.0858 L16.4803,18.9858 L14.7197,21.2142 L4.71974,13.3142Z',
    accent: {
      d: 'M19.4 5.9a2.0 2.0 0 1 0 0 4.0a2.0 2.0 0 1 0 0-4.0Z',
      fill: '#1d7ffb',
    },
  },

  agy: {
    // Traced from the vendor's own app icon: Antigravity's arch, the shape that
    viewBox: '0 0 24 24',
    d: 'M11.24,2.58 L12.76,2.58 L13.84,3.01 L14.71,3.66 L15.79,5.18 L17.74,10.81 L18.83,15.14 L19.91,17.53 L22.29,20.56 L22.29,21.21 L21.86,21.43 L20.99,21.43 L19.91,20.78 L18.18,19.04 L15.57,14.71 L14.06,13.19 L12.76,12.76 L11.89,12.54 L9.94,13.19 L8.21,15.14 L6.04,18.83 L3.88,20.99 L3.01,21.43 L1.71,21.21 L1.93,20.34 L3.01,19.26 L4.96,15.79 L6.91,8.86 L8.43,4.96 L10.16,3.01Z',
  },


  zcode: {
    // Measured from the vendor tile (a dark rounded square with the "Z" knocked
  // out): one thick diagonal band plus two detached horizontal ticks. Written by
  // hand from sampled mask spans because a raster trace slurred the tick ends
  // and skewed the letter. Geometry in `data/trace-icons.py` `HAND_FIT`.
    viewBox: '0 0 24 24',
    d: 'M14.16,2.77 L22.76,2.77 L9.76,21.23 L1.2,21.23ZM1.71,2.77 L12.47,2.77 L10.31,5.9 L1.71,5.9ZM13.82,18.01 L22.25,18.01 L22.25,21.23 L11.62,21.23Z',
  },
  qoderclicn: {
    // Traced at the artwork's native 256px from the icon embedded in
    // `qoderclicn.exe`: two interlocking rounded forms with the white crescent
    // between them — the part a coarse trace loses.
    //
    // Rendered as the vendor's OUTLINE variant (stroked, not filled): the app
    // tile uses a solid green fill, while the monochrome mark is a line drawing,
    // and the outline is what matches the other marks here.
    fillRule: 'evenodd',
    viewBox: '0 0 24 24',
    strokeWidth: 1.75,
    d: 'M9.6,1.64 L10.82,1.72 L10.9,1.8 L11.47,1.88 L11.96,2.13 L12.04,2.29 L12.53,2.53 L12.69,2.53 L13.34,2.86 L13.67,3.1 L13.99,3.18 L14.07,3.35 L14.72,3.67 L14.88,3.67 L15.05,3.83 L15.86,4.24 L16.18,4.32 L16.27,4.48 L16.51,4.57 L16.67,4.73 L17,4.89 L17.16,4.89 L18.05,5.38 L18.22,5.38 L18.22,5.46 L18.38,5.62 L19.19,6.03 L19.35,6.03 L19.68,6.19 L19.84,6.35 L20.08,6.43 L20.33,6.76 L20.49,6.76 L20.98,7.25 L20.98,7.33 L21.22,7.57 L21.22,7.73 L21.38,7.9 L21.38,7.98 L21.55,8.06 L21.79,8.63 L21.79,8.87 L21.87,8.95 L21.87,9.2 L21.95,9.28 L21.95,9.6 L22.03,9.68 L22.03,20.9 L21.95,20.98 L21.95,21.14 L21.55,21.63 L21.3,21.71 L21.22,21.87 L21.06,21.87 L20.98,21.95 L20.17,21.95 L20.08,21.87 L19.92,21.87 L19.84,21.71 L19.35,21.47 L18.95,21.38 L18.3,21.06 L18.22,21.14 L17.89,21.22 L17.73,21.38 L17.24,21.63 L17,21.63 L16.83,21.71 L16.75,21.87 L16.18,22.03 L16.02,22.12 L15.37,22.2 L15.29,22.28 L14.88,22.28 L14.8,22.36 L13.58,22.36 L13.5,22.28 L13.1,22.28 L12.77,22.12 L12.28,22.03 L11.96,21.87 L11.96,21.79 L11.8,21.63 L11.47,21.47 L11.31,21.47 L10.42,20.98 L10.25,20.98 L10.09,20.82 L10.01,20.82 L9.93,20.65 L9.28,20.33 L9.12,20.33 L8.14,19.76 L7.82,19.68 L7.73,19.52 L7.08,19.19 L6.92,19.19 L6.76,19.03 L5.95,18.62 L5.78,18.62 L5.7,18.46 L5.46,18.38 L5.3,18.22 L4.81,17.97 L4.65,17.97 L3.92,17.57 L3.75,17.32 L3.59,17.32 L3.02,16.75 L3.02,16.67 L2.78,16.43 L2.78,16.27 L2.62,15.94 L2.45,15.86 L2.21,15.29 L2.21,15.05 L2.13,14.97 L2.13,14.72 L2.05,14.64 L2.05,14.15 L1.97,14.07 L1.97,9.2 L2.05,9.12 L2.05,8.55 L2.13,8.47 L2.29,7.57 L2.37,7.49 L2.45,7.08 L2.62,7 L2.78,6.68 L2.78,6.43 L2.86,6.27 L3.02,6.11 L3.51,5.13 L3.83,4.89 L3.83,4.81 L4.24,4.4 L4.32,4.16 L4.65,3.83 L4.81,3.83 L5.3,3.35 L5.38,3.35 L5.54,3.1 L5.62,3.1 L5.78,2.94 L5.95,2.94 L6.35,2.62 L6.84,2.37 L7.08,2.37 L7.25,2.29 L7.33,2.13 L7.49,2.13 L7.82,1.97 L8.14,1.97 L8.22,1.88 L8.79,1.8 L8.87,1.72 L9.52,1.72ZM13.99,6.84 L14.15,6.84 L14.15,10.33 L14.07,10.42 L14.07,11.15 L13.99,11.23 L13.99,11.55 L13.91,11.63 L13.91,11.88 L13.83,11.96 L13.75,12.45 L13.58,12.53 L13.42,13.18 L13.1,13.83 L12.93,13.99 L12.85,14.32 L12.69,14.48 L12.69,14.56 L12.37,14.8 L12.37,14.88 L12.12,15.13 L12.12,15.29 L11.47,15.94 L11.39,15.94 L11.07,16.27 L10.98,16.27 L10.74,16.59 L10.66,16.59 L10.42,16.83 L10.25,16.83 L9.85,17.08 L9.77,17.16 L9.77,13.18 L9.85,13.1 L9.85,12.61 L9.93,12.53 L10.01,11.88 L10.09,11.8 L10.17,11.39 L10.25,11.23 L10.42,11.15 L10.42,10.9 L10.82,10.09 L10.98,9.93 L11.07,9.6 L11.23,9.44 L11.23,9.36 L11.55,9.12 L11.55,9.03 L11.8,8.79 L11.88,8.55 L12.53,7.9 L12.85,7.73 L13.18,7.33 L13.26,7.33 L13.67,7 L13.83,7Z',
  },



  hermes: {
    // Traced from the vendor's desktop icon in LINE-ART form (its counters left
    // open). NOTE: that artwork is a detailed character portrait, not a geometric
    // mark, so this is the original's own strokes rather than a designed glyph.
    // The filled-silhouette alternative was measured too and lost the face at
    // 64px, which is the size that decides whether the mark reads at all; a
    // purpose-drawn simplification would beat both if one becomes available.
    fillRule: 'evenodd',
    viewBox: '0 0 24 24',
    d: 'M8.83,2.33 L10.13,2.33 L11.76,3.14 L12.24,3.63 L12.89,4.77 L12.73,4.77 L12.57,5.09 L12.73,5.26 L13.06,5.09 L13.38,6.72 L13.54,6.88 L13.87,6.72 L13.71,6.39 L14.19,6.39 L14.36,6.23 L14.52,6.39 L14.68,6.23 L14.36,5.09 L15.01,5.42 L15.33,5.26 L15.17,5.09 L15.66,5.26 L15.98,5.09 L16.47,5.42 L16.96,4.77 L16.96,4.12 L17.12,4.28 L16.96,4.44 L17.28,4.61 L18.09,6.72 L18.58,9.48 L18.74,9.64 L18.74,10.29 L18.91,10.46 L18.91,10.94 L19.72,13.71 L19.72,14.36 L19.88,14.52 L19.88,16.79 L19.23,18.26 L19.39,18.42 L20.37,17.12 L20.69,15.98 L20.53,14.84 L20.86,15.66 L20.86,16.96 L20.37,18.09 L18.58,19.56 L18.42,20.37 L17.93,19.23 L16.79,18.09 L16.47,17.93 L15.17,17.93 L14.52,18.26 L13.22,19.56 L12.73,20.53 L12.41,22.32 L12.24,22.32 L12.41,21.34 L12.57,21.18 L12.89,19.39 L14.19,18.09 L14.03,17.93 L13.71,18.09 L13.38,17.93 L11.59,19.07 L11.27,19.23 L11.11,19.07 L8.34,22.32 L8.18,21.99 L7.86,22.32 L6.07,22.32 L6.39,21.67 L6.23,21.51 L6.07,21.51 L5.42,22.32 L5.09,22.32 L5.09,21.83 L5.42,21.34 L7.21,19.39 L7.37,18.58 L7.21,18.42 L7.04,18.74 L6.56,19.07 L5.74,19.07 L4.93,18.42 L4.77,17.93 L3.96,17.61 L3.14,16.47 L3.31,14.52 L3.47,14.19 L3.47,15.17 L4.12,15.82 L4.77,15.82 L5.26,15.33 L5.58,14.52 L5.74,12.41 L5.91,12.24 L6.07,10.13 L5.74,9.81 L5.42,9.97 L5.58,10.13 L4.77,9.81 L4.12,8.83 L4.12,8.18 L3.96,8.02 L4.12,7.86 L4.12,6.88 L4.44,5.91 L4.61,5.58 L4.61,6.07 L4.77,6.23 L5.09,6.07 L5.26,6.39 L5.42,6.07 L5.58,6.23 L6.23,6.07 L6.56,5.74 L6.23,5.42 L5.91,5.42 L6.07,5.26 L5.74,4.93 L5.42,5.09 L5.58,4.93 L5.26,4.77 L5.26,4.61 L7.04,3.14ZM10.94,1.68 L13.06,1.68 L13.22,1.84 L13.87,1.84 L15.82,2.82 L16.47,3.47 L16.31,3.63 L16.47,3.79 L16.47,4.28 L16.14,4.12 L15.66,4.77 L15.49,4.77 L15.01,4.77 L14.84,4.44 L14.68,4.77 L14.19,4.93 L14.19,4.61 L13.54,3.47 L12.41,2.33 L11.27,1.84 L10.13,1.84 L10.78,1.84ZM12.24,19.56 L11.59,21.18 L11.43,22.32 L10.78,22.32 L10.29,22.32 L10.46,21.99ZM8.99,8.83 L9.97,8.99 L10.78,9.48 L10.46,9.81 L10.13,9.32 L9.81,9.64 L9.81,9.97 L10.13,10.13 L9.81,10.29 L9.16,10.29 L9.64,10.29 L9.81,10.13 L9.16,9.81 L9.16,9.32 L8.99,9.16 L8.83,9.48 L8.67,9.48 L8.83,9.32 L8.67,9.16ZM11.27,17.12 L11.43,17.12 L11.76,18.09 L11.27,17.77 L10.94,17.93 L10.62,17.61 L11.11,17.61 L11.27,17.77 L11.43,17.61 L11.43,17.44 L11.11,17.28ZM6.88,12.41 L7.21,12.73 L7.86,12.73 L8.18,12.89 L8.18,13.06 L7.86,12.89 L7.37,13.06 L7.21,12.89 L7.04,13.22ZM7.37,8.51 L7.53,8.67 L8.34,8.67 L8.18,8.83 L8.34,8.99 L9.16,8.51 L9.64,8.51 L9.81,8.67 L11.11,8.67 L11.27,8.51 L12.08,8.99 L11.92,11.11 L11.76,11.27 L11.43,13.87 L11.27,14.03 L11.27,15.82 L11.27,15.98 L10.94,16.14 L10.62,15.49 L9.97,14.84 L7.86,15.01 L7.04,13.87 L6.39,12.24 L6.39,11.43 L6.72,11.27 L6.56,11.11 L7.21,10.46 L7.37,9.81 L6.88,9.48 L6.39,9.48 L6.23,9.16 L7.21,8.83ZM11.43,16.47 L12.89,17.77 L11.27,18.74 L10.94,18.91 L10.78,18.74 L10.78,18.42 L10.13,17.44 L10.46,17.44ZM10.62,4.44 L11.27,5.58 L11.11,5.91 L10.62,5.58 L10.29,5.74 L9.97,5.74 L9.64,5.58 L9.64,5.42 L10.13,5.26 L10.62,4.77ZM18.74,13.38 L19.07,14.36 L19.07,15.33 L18.74,16.14 L18.42,16.47 L18.74,15.49ZM7.04,4.93 L7.04,5.09 L7.53,5.42 L8.02,5.42 L8.34,4.93 L8.34,5.74 L8.18,5.58 L7.69,5.74 L7.21,5.74 L7.04,5.26 L6.72,5.74 L6.72,6.07 L6.56,5.58ZM8.51,20.21 L8.83,20.21 L8.18,21.51 L7.69,21.99 L7.86,21.02ZM12.08,3.96 L12.24,4.28 L11.92,4.61 L12.08,4.77 L11.59,5.09 L11.43,4.93 L11.11,4.77 L11.27,4.44ZM6.07,15.98 L6.07,16.31 L5.09,17.12 L4.28,17.12 L3.79,16.79 L4.12,16.96 L4.93,16.96 L5.58,16.63ZM6.88,16.96 L6.88,17.28 L6.23,18.26 L5.91,18.42 L5.26,18.26 L5.26,18.09 L6.23,17.93 L6.72,17.44ZM13.54,14.84 L13.54,15.33 L13.71,15.49 L13.38,15.82 L13.06,15.82 L12.89,15.82 L12.73,15.49ZM8.67,5.09 L9.32,5.09 L9.32,5.58 L8.67,5.58ZM13.38,13.06 L13.38,14.19 L12.89,14.52Z',
  },

  grok: {
    // Traced from the artwork the user supplied (102x98 PNG: the black ring and
    // its diagonal slash on a white page), at the 50% anti-aliased edge
    // (mask: luma < 128, grid 160, epsilon 1.4). The trace is
    // EIGHT-connected, which is load-bearing rather than cosmetic: the slash's
    // two tips are ~1px diagonals, and a 4-connected contour fragments them into
    // stubs the minimum-size filter then drops, silently lopping about 6% off
    // each tip. IoU against the source artwork: 0.909.
    //
    // The vendor's own ACP-registry icon (`data/vendor-icons/grok-build.svg`,
    // 16x16) is the SAME mark drawn about one source pixel BOLDER: it scores
    // 0.807 against this artwork under the same mask rule, and 0.901 against a
    // deliberately bolder iso-line, with the difference sitting uniformly on the
    // outer contour. The traced path is what matches the supplied artwork, so it
    // is the one shipped; the official path is recorded in
    // `docs/engine-registry.md` should a vendor-native vector be preferred later.
    fillRule: 'evenodd',
    viewBox: '0 0 24 24',
    d: 'M22.21,2.32 L22.34,2.45 L21.56,3.09 L21.56,3.62 L21.3,3.62 L21.17,4.13 L20.65,4.53 L20.65,5.3 L20.13,5.96 L20.13,9.21 L20.39,9.34 L20.39,10.38 L20.65,10.5 L20.65,13.11 L20.39,13.23 L20.39,14.28 L20.13,14.4 L19.87,15.71 L19.48,15.83 L18.7,17.4 L17.53,18.44 L17.14,18.44 L16.75,19.09 L16.23,19.09 L14.79,19.87 L13.75,19.87 L13.62,20.13 L10.12,19.87 L9.98,19.61 L9.21,19.61 L8.17,19.09 L7.9,18.57 L9.85,17.53 L11.15,17.79 L11.29,18.05 L13.62,18.05 L13.75,17.79 L14.79,17.79 L15.18,17.53 L17.4,15.71 L17.4,15.18 L17.92,14.79 L17.92,14.15 L18.31,14.02 L18.31,13.23 L18.57,13.11 L18.57,10.77 L18.31,10.63 L18.31,9.85 L17.92,9.72 L17.53,8.95 L15.45,9.98 L14.79,10.89 L14.28,10.89 L13.62,11.68 L13.23,11.68 L13.11,12.07 L12.32,12.32 L11.68,13.11 L11.29,13.11 L10.5,14.02 L10.38,13.88 L21.04,3.36 L21.04,3.09 L21.56,3.09ZM10.63,3.75 L13.88,3.75 L14.02,4.01 L15.05,4.01 L15.18,4.27 L16.48,4.53 L16.75,5.3 L16.23,5.3 L15.05,6.09 L14.28,6.09 L14.15,5.83 L10.63,5.83 L10.5,6.09 L9.21,6.35 L8.81,7 L8.43,7 L7.38,7.9 L7.38,8.43 L6.87,8.81 L6.35,9.85 L6.09,12.85 L6.35,12.97 L6.61,14.53 L7.12,14.93 L7.38,15.71 L7.78,15.83 L7.78,16.23 L5.7,17.79 L4.39,19.35 L3.62,19.61 L2.71,20.78 L1.67,21.56 L3.88,19.09 L4.13,18.31 L4.53,18.18 L4.79,16.88 L5.04,16.75 L4.53,13.88 L4.13,13.75 L4.13,10.12 L4.53,9.98 L4.53,9.08 L5.04,8.43 L5.3,7.38 L5.83,7 L5.83,6.47 L7,5.44 L7.78,5.18 L7.9,4.79 L9.6,4.01 L10.5,4.01Z',
  },

  minimaxcode: {
    // Traced from the artwork the user supplied (93x94 PNG: a white blob — two
    // ears, three lobes — on the brand's blue tile), grid 160, epsilon 1.4,
    // IoU 0.979.
    //
    // The mask rule is the interesting part: the tile is a GRADIENT (corner
    // rgb(0,161,253)), so a luminance or "not white" threshold swallows part of
    // the page and eats into the mark. The mark is the only thing whose DARKEST
    // channel is high, so the rule is `min(R,G,B) > 185`; the page's brightest
    // min-channel is 140, and the mask's bounding box stays >=9px inside the
    // frame, so no background can pass it.
    fillRule: 'evenodd',
    viewBox: '0 0 24 24',
    d: 'M10.77,1.67 L14.93,1.93 L15.05,2.32 L16.48,2.58 L18.05,3.75 L18.57,3.75 L18.7,4.13 L18.96,4.13 L19.09,3.75 L21.04,3.75 L21.17,4.13 L21.95,4.39 L21.69,5.56 L21.43,5.56 L21.3,5.18 L19.87,5.04 L20.39,6.09 L20.78,6.21 L21.3,7.9 L21.69,8.04 L21.69,9.21 L21.95,9.34 L21.69,13.5 L21.3,13.62 L21.04,15.05 L20.39,15.45 L20.39,15.97 L20.13,16.1 L20.78,16.62 L20.78,17.14 L21.3,17.92 L21.3,18.96 L21.04,19.09 L20.78,20.26 L19.87,20.78 L17.53,20.78 L17,20.26 L16.62,20.26 L15.83,19.22 L15.05,19.22 L14.67,19.73 L14.67,20.78 L14.28,20.91 L14.28,21.43 L13.75,22.08 L13.23,22.08 L13.11,22.34 L11.03,22.34 L10.5,22.08 L10.5,21.82 L9.85,21.43 L9.6,19.73 L9.21,19.61 L9.08,19.22 L8.69,19.22 L8.55,19.61 L8.04,19.61 L7.65,20.26 L6.74,20.78 L4.39,20.78 L3.88,20.26 L3.49,20.26 L3.49,19.73 L3.09,19.61 L3.09,18.83 L2.83,18.7 L3.09,17.27 L3.49,17.14 L3.49,16.62 L4.01,16.48 L4.01,16.1 L3.75,15.97 L3.49,14.79 L3.09,14.67 L3.09,14.15 L2.83,14.02 L2.58,12.07 L2.19,11.94 L2.19,9.98 L2.58,9.85 L2.83,7.52 L3.09,7.38 L3.09,6.87 L3.49,6.74 L3.49,6.21 L4.01,5.83 L4.01,5.04 L3.49,4.92 L2.19,5.56 L1.93,4.39 L3.49,3.49 L5.18,3.75 L5.44,4.13 L5.56,3.75 L7,3.23 L7.12,2.83 L7.65,2.83 L8.29,2.32 L9.08,2.32 L9.21,1.93 L10.63,1.93Z',
  },
}
