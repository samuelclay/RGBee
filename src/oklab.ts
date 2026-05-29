// src/oklab.ts
// Pure color-math module for RGBee. No Cloudflare/Worker/DO dependencies — usable
// in both the Worker runtime and in plain TypeScript tests.
//
// Implements the OKLab/OKLCh color space (Björn Ottosson) with the exact matrices
// specified in the build spec, plus percentage-based scoring and a volume-aware
// (shrinkage) ranking helper for the leaderboard.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A color in the OKLab space. */
export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/** A freshly-generated target color: its hex string and its OKLab coordinates. */
export interface TargetColor {
  hex: string;
  oklab: Oklab;
}

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/**
 * Scoring falloff. score = round(100 * exp(-K_FALLOFF * oklabDistance)).
 * Playtest target: a pretty-close guess scores ~85-90, a wild miss bottoms low.
 */
export const K_FALLOFF = 4.0;

/** Bayesian shrinkage prior mean (percent) for ranking few-round players. */
export const PRIOR_MEAN = 55;

/** Bayesian shrinkage prior weight (in "virtual rounds"). */
export const PRIOR_WEIGHT = 3;

// ---------------------------------------------------------------------------
// sRGB gamma <-> linear helpers (per-channel)
// ---------------------------------------------------------------------------

/** Convert a single gamma-encoded sRGB channel (0..1) to linear light. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Convert a single linear-light channel to gamma-encoded sRGB (0..1). */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// ---------------------------------------------------------------------------
// hex parsing / formatting
// ---------------------------------------------------------------------------

/** Parse "#RRGGBB" (or "RRGGBB", with optional surrounding whitespace) to sRGB 0..1. */
function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return { r, g, b };
}

/** Format a single 0..1 linear-gamma sRGB channel as a two-digit hex byte. */
function channelToHex(c: number): string {
  const v = Math.max(0, Math.min(255, Math.round(c * 255)));
  return v.toString(16).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// OKLab conversions (exact Ottosson matrices)
// ---------------------------------------------------------------------------

/**
 * Convert a hex color string "#RRGGBB" to OKLab.
 * sRGB -> linearize -> Ottosson linear-sRGB->LMS -> cbrt -> LMS'->OKLab.
 */
export function hexToOklab(hex: string): Oklab {
  const { r: rs, g: gs, b: bs } = parseHex(hex);

  const r = srgbToLinear(rs);
  const g = srgbToLinear(gs);
  const b = srgbToLinear(bs);

  return linearSrgbToOklab(r, g, b);
}

/** Convert linear-light sRGB (each 0..1) to OKLab using the exact Ottosson matrices. */
function linearSrgbToOklab(r: number, g: number, b: number): Oklab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

/** Convert OKLab to linear-light sRGB (each channel, may fall outside 0..1 if out of gamut). */
function oklabToLinearSrgb(c: Oklab): { r: number; g: number; b: number } {
  const l_ = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b;
  const m_ = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b;
  const s_ = c.L - 0.0894841775 * c.a - 1.2914855480 * c.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

// ---------------------------------------------------------------------------
// Distance & scoring
// ---------------------------------------------------------------------------

/** Euclidean distance between two OKLab colors. */
export function oklabDistance(a: Oklab, b: Oklab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Score a guess against a target (given as precomputed OKLab) as a percentage 0..100.
 * score = round(100 * exp(-K_FALLOFF * dist)), clamped to 0..100.
 */
export function scoreGuess(guessHex: string, targetOklab: Oklab): number {
  const dist = oklabDistance(hexToOklab(guessHex), targetOklab);
  const raw = Math.round(100 * Math.exp(-K_FALLOFF * dist));
  return Math.max(0, Math.min(100, raw));
}

// ---------------------------------------------------------------------------
// Random target generation (OKLCh, gamut-checked)
// ---------------------------------------------------------------------------

/**
 * Generate a fresh curated target color by sampling in OKLCh and rejecting
 * out-of-gamut samples. Avoids muddy dead zones via constrained chroma/lightness.
 *   hue:       uniform 0..360
 *   chroma:    uniform [0.08, 0.22]
 *   lightness: uniform [0.50, 0.85]
 * Caps at ~50 resample tries; the last (clamped) candidate is returned if exhausted.
 */
export function randomTargetColor(): TargetColor {
  const EPS = 1e-4;
  const MAX_TRIES = 50;

  let last: { hex: string; oklab: Oklab } | null = null;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const h = Math.random() * 360;
    const C = 0.08 + Math.random() * (0.22 - 0.08);
    const L = 0.5 + Math.random() * (0.85 - 0.5);

    const hRad = (h * Math.PI) / 180;
    const oklab: Oklab = {
      L,
      a: C * Math.cos(hRad),
      b: C * Math.sin(hRad),
    };

    const { r, g, b } = oklabToLinearSrgb(oklab);

    // Gamut test uses the UNCLAMPED linear channels.
    const rs = linearToSrgb(r);
    const gs = linearToSrgb(g);
    const bs = linearToSrgb(b);

    const inGamut =
      rs >= -EPS && rs <= 1 + EPS &&
      gs >= -EPS && gs <= 1 + EPS &&
      bs >= -EPS && bs <= 1 + EPS;

    // Clamp the linear channels to [0,1] BEFORE gamma-encoding for the hex.
    // Out-of-gamut linear values can be negative; Math.pow(negative, 1/2.4)
    // returns NaN -> channelToHex(NaN) -> a malformed "#NaNNaNNaN" hex. The
    // clamp guarantees the candidate (and the exhaustion fallback) is always a
    // well-formed hex.
    const clamp01 = (c: number) => Math.max(0, Math.min(1, c));
    const hex = `#${channelToHex(linearToSrgb(clamp01(r)))}${channelToHex(
      linearToSrgb(clamp01(g)),
    )}${channelToHex(linearToSrgb(clamp01(b)))}`.toUpperCase();

    if (inGamut) {
      // Re-derive OKLab from the quantized hex so target matches what players see/guess.
      return { hex, oklab: hexToOklab(hex) };
    }

    last = { hex, oklab: hexToOklab(hex) };
  }

  // Exhausted tries: return the last clamped candidate (guaranteed valid hex).
  return last ?? { hex: "#808080", oklab: hexToOklab("#808080") };
}

// ---------------------------------------------------------------------------
// Volume-aware ranking (Bayesian shrinkage)
// ---------------------------------------------------------------------------

/**
 * Shrinkage-adjusted ranking score for the leaderboard.
 *   rankedScore = (PRIOR_MEAN*PRIOR_WEIGHT + total) / (PRIOR_WEIGHT + rounds)
 * Discounts few-round players so e.g. 94%@10rounds outranks 97%@1round.
 * `total` is the sum of per-round percentage scores; `rounds` is rounds submitted.
 */
export function rankedScore(total: number, rounds: number): number {
  return (PRIOR_MEAN * PRIOR_WEIGHT + total) / (PRIOR_WEIGHT + rounds);
}
