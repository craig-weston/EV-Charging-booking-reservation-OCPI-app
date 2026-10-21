// White-label theming: the whole palette is derived from one brand colour.
import type { Brand } from "../../shared/model";

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`;

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: RGB, b: RGB): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Moves `fg` towards `toward` until it reaches `ratio` contrast against `bg`. */
function ensureContrast(fg: RGB, bg: RGB, toward: RGB, ratio = 4.5): RGB {
  let c = fg;
  for (let i = 0; i <= 20 && contrast(c, bg) < ratio; i++) c = mix(fg, toward, i / 20);
  return c;
}

export interface BrandTokens {
  brand: string;
  ink: string;
  textLight: string;
  textDark: string;
}

export function brandTokens(color: string): BrandTokens {
  const rgb = hexToRgb(color) ?? hexToRgb("#2f5bea")!;
  const white: RGB = [255, 255, 255];
  const black: RGB = [17, 19, 23];
  const ink = contrast(rgb, white) >= contrast(rgb, black) ? "#ffffff" : "#111317";
  return {
    brand: toHex(rgb),
    ink,
    textLight: toHex(ensureContrast(rgb, white, [0, 0, 0])),
    textDark: toHex(ensureContrast(rgb, [27, 31, 37], white)),
  };
}

function monogramSvg(name: string, t: BrandTokens) {
  const letter = (name.trim()[0] ?? "H").toUpperCase().replace(/[<&>"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${t.brand}"/><text x="32" y="44" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="36" fill="${t.ink}">${letter}</text></svg>`;
}

/** Applies a brand to the document: CSS variables, favicon and title. */
export function applyBrand(brand: Brand, theme: "system" | "light" | "dark" = "system") {
  const t = brandTokens(brand.primary_color);
  const root = document.documentElement;
  root.style.setProperty("--brand", t.brand);
  root.style.setProperty("--brand-ink", t.ink);
  root.style.setProperty("--brand-text", "var(--brand-text-mode)");
  root.style.setProperty("--brand-text-light", t.textLight);
  root.style.setProperty("--brand-text-dark", t.textDark);
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  root.style.setProperty("--brand-text-mode", dark ? t.textDark : t.textLight);
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  const icon = brand.logo_url && brand.logo_url.startsWith("data:image/svg") ? brand.logo_url : `data:image/svg+xml,${encodeURIComponent(monogramSvg(brand.name, t))}`;
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = icon;
  const meta = document.querySelector<HTMLMetaElement>("meta[name='theme-color']");
  if (meta) meta.content = t.brand;
}

export const BRAND_SWATCHES = ["#2F5BEA", "#0E7C66", "#6D3FD1", "#C2410C", "#B91C5C", "#0F766E", "#1F2937", "#E3A008"];
