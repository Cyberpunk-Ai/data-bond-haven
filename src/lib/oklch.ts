/**
 * oklch -> hex, as a pure function.
 *
 * Why this exists: `theme-color` is what paints the browser's address bar and
 * the Android task switcher, and it has to be a plain colour that every browser
 * understands — while the app's own palette is written in oklch (see
 * `src/styles.css` and `ACCENT_PALETTES`). Hand-copying a hex next to an oklch
 * token is how the two drift apart, so the hex is *derived* here and the
 * derivation is tested against the value the browser itself produces.
 *
 * The math is the spec's own chain: oklch -> oklab -> linear OKLab->XYZ ->
 * linear sRGB -> gamma-encoded sRGB, clamped to the gamut. Clamping is
 * deliberate: several of the brand accents sit outside sRGB (the browser
 * gamut-maps them too), and a hex is the closest printable colour.
 */

const D65_TO_SRGB: readonly [readonly number[], readonly number[], readonly number[]] = [
  [+4.0767416621, -3.3077115913, +0.2309699292],
  [-1.2684380046, +2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, +1.707614701],
];

/** `oklch(0.541 0.281 293.009)` / `oklch(62% 0.19 155)` -> components, or null. */
export function parseOklch(color: string): { l: number; c: number; h: number } | null {
  const body = /^oklch\(([^)]+)\)$/i.exec(String(color ?? "").trim())?.[1];
  if (!body) return null;
  // Space- or comma-separated; an alpha slot (`/ 0.5`) is ignored, and a `%`
  // lightness is the same colour as the 0..1 form the palette uses.
  const parts = body
    .split(/[\s,/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const [lRaw, cRaw, hRaw] = parts;
  const l = lRaw.endsWith("%") ? Number(lRaw.slice(0, -1)) / 100 : Number(lRaw);
  const c = Number(cRaw);
  const h = hRaw.endsWith("deg") ? Number(hRaw.slice(0, -3)) : Number(hRaw);
  if (!Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(h)) return null;
  return { l, c, h };
}

function toRgbComponents({
  l,
  c,
  h,
}: {
  l: number;
  c: number;
  h: number;
}): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  // oklab -> OKLab LMS cube roots, then cube them into linear LMS.
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const lms = [l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_];
  return D65_TO_SRGB.map((row) => row[0] * lms[0] + row[1] * lms[1] + row[2] * lms[2]) as [
    number,
    number,
    number,
  ];
}

/** sRGB transfer curve: linear -> gamma-encoded 0..255, clamped to the gamut. */
function encode8(linear: number): number {
  const v =
    linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(Math.max(0, linear), 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/**
 * A CSS oklch colour as `#rrggbb`, or null when the input is not oklch.
 * Anything already in hex/rgb form is handed straight back, so callers can use
 * this on a mixed palette without a second branch.
 */
export function toCssHex(color: string): string | null {
  const raw = String(color ?? "").trim();
  if (!raw) return null;
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    const [r, g, b] = raw.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const oklch = parseOklch(raw);
  if (!oklch) return null;
  const [r, g, b] = toRgbComponents(oklch).map(encode8);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
