export const APPEARANCE_STORAGE_KEY = 'interfacePreferences';

export const DEFAULT_APPEARANCE = Object.freeze({
  version: 1,
  font: 'system',
  bodyFontSize: 13,
  density: 'comfortable',
  accent: 'forest',
  texture: 'none',
  companion: 'dynamic',
});

const FONTS = new Set(['system', 'humanist', 'serif', 'rounded']);
const BODY_FONT_SIZES = new Set([12, 13, 14, 16, 18, 20]);
const DENSITIES = new Set(['compact', 'comfortable', 'spacious']);
const ACCENTS = new Set(['forest', 'ocean', 'amber', 'tiffany', 'wine']);
const TEXTURES = new Set(['none', 'grain']);

export function normalizeAppearance(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return { ...DEFAULT_APPEARANCE };
  return {
    version: 1,
    font: FONTS.has(value.font) ? value.font : DEFAULT_APPEARANCE.font,
    bodyFontSize: BODY_FONT_SIZES.has(value.bodyFontSize) ? value.bodyFontSize : DEFAULT_APPEARANCE.bodyFontSize,
    density: DENSITIES.has(value.density) ? value.density : DEFAULT_APPEARANCE.density,
    accent: ACCENTS.has(value.accent) ? value.accent : DEFAULT_APPEARANCE.accent,
    texture: TEXTURES.has(value.texture) ? value.texture : value.grain === true ? 'grain' : DEFAULT_APPEARANCE.texture,
    companion: ['dynamic', 'static', 'off'].includes(value.companion) ? value.companion : DEFAULT_APPEARANCE.companion,
  };
}

export function applyAppearance(document, value) {
  const appearance = normalizeAppearance(value);
  const root = document.documentElement;
  root.dataset.font = appearance.font;
  root.dataset.bodyFontSize = String(appearance.bodyFontSize);
  root.dataset.density = appearance.density;
  root.dataset.accent = appearance.accent;
  root.dataset.texture = appearance.texture;
  root.dataset.companion = appearance.companion;
  root.dataset.grain = appearance.texture === 'grain' ? 'on' : 'off';
  try { document.defaultView.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance)); } catch {}
  return appearance;
}
