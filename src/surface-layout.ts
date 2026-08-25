/**
 * Centers a scaled live surface inside the printable width. When the scaled
 * surface is wider than the page, the negative offset keeps both sides clipped
 * symmetrically instead of anchoring the crop to the left edge.
 */
export function computeCenteredSurfaceOffset(
  usableWidthPx: number,
  scaledContentWidthPx: number,
  insetPx: number
): number {
  const usableWidth = Math.max(0, Number.isFinite(usableWidthPx) ? usableWidthPx : 0);
  const scaledWidth = Math.max(0, Number.isFinite(scaledContentWidthPx) ? scaledContentWidthPx : 0);
  const inset = Number.isFinite(insetPx) ? insetPx : 0;
  return inset + (usableWidth - scaledWidth) / 2;
}
