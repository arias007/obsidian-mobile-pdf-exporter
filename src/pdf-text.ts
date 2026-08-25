const ARABIC_PRESENTATION_FORM_RANGES = [
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff]
] as const;

function isArabicPresentationForm(codePoint: number): boolean {
  return ARABIC_PRESENTATION_FORM_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function decodePdfUnicodeHex(hex: string): string {
  let text = "";
  for (let index = 0; index + 3 < hex.length; index += 4) {
    text += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  }
  return text;
}

function encodePdfUnicodeHex(text: string): string {
  let hex = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0xffff) {
      hex += codePoint.toString(16).padStart(4, "0").toUpperCase();
      continue;
    }
    const adjusted = codePoint - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    hex += high.toString(16).padStart(4, "0").toUpperCase();
    hex += low.toString(16).padStart(4, "0").toUpperCase();
  }
  return hex;
}

function normalizeArabicPresentationForms(text: string): string {
  return Array.from(text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isArabicPresentationForm(codePoint) ? character.normalize("NFKC") : character;
  }).join("");
}

/**
 * Normalize only ToUnicode destinations. PDF syntax and source CIDs stay
 * unchanged; Arabic presentation-form destinations become base code points so
 * copy/paste returns the original logical Arabic text.
 */
export function normalizePdfToUnicodeCMap(cmap: string): string {
  return cmap.replace(
    /^(\s*<[^>]+>\s+(?:<[^>]+>\s+)?)(<([0-9A-Fa-f]+)>)(\s*)$/gmu,
    (_match, prefix: string, destination: string, hex: string, suffix: string) => {
      const normalized = normalizeArabicPresentationForms(decodePdfUnicodeHex(hex));
      return `${prefix}<${encodePdfUnicodeHex(normalized)}>${suffix}`;
    }
  );
}

/** Extra width keeps the last glyph visible when browser range metrics round down. */
export function getTextFragmentPaintWidth(
  left: number,
  right: number,
  fontSizePx: number,
  sourceWidthPx: number
): number {
  const available = Math.max(1, sourceWidthPx - Math.max(0, left));
  const safety = Math.max(6, Math.min(18, Math.max(1, fontSizePx) * 0.45));
  return Math.max(1, Math.min(available, Math.max(1, right - left) + safety));
}
