/**
 * DPR-aware sizing helpers for the river hybrid shell.
 *
 * Mirrors the guards in `@vectojs/core`:
 * - `CanvasRenderer.effectiveDPR` (renderer/CanvasRenderer.ts:216)
 * - `CanvasRenderer.resize` backing-store math (renderer/CanvasRenderer.ts:249)
 * - `CanvasGeometry.effectiveDPR` + `sizeGpuCanvas` (tree/scene/CanvasGeometry.ts)
 * - `Scene.watchDevicePixelRatio` epsilon 0.001 + poll fallback (tree/Scene.ts:2610)
 *
 * The shell must not hardcode `canvas.width = css * devicePixelRatio` without
 * rounding / max(1) / NaN guards — otherwise DPR 1.5/2/3 produces sub-pixel
 * backing stores, white-screen on NaN/Infinity, or 0-height on iOS URL-bar
 * collapse. All callers should go through these helpers and then delegate to
 * `Scene.resize(cssW, cssH)` so the renderer owns the backing store.
 */

/** Epsilon for DPR change detection — must match Scene.watchDevicePixelRatio. */
export const DPR_EPSILON = 0.001;

/**
 * Effective DPR, mirroring CanvasRenderer.effectiveDPR / CanvasGeometry.effectiveDPR.
 * Reads `window.devicePixelRatio` when available, clamps to `maxDPR` when set.
 */
export function effectiveDPR(maxDPR?: number): number {
  const raw =
    typeof window !== 'undefined'
      ? (window as unknown as { devicePixelRatio?: number }).devicePixelRatio
      : 1;
  const real = Number.isFinite(raw) && (raw as number) > 0 ? (raw as number) : 1;
  if (maxDPR === undefined) return real;
  if (!Number.isFinite(maxDPR) || maxDPR <= 0) return real;
  return Math.min(real, maxDPR);
}

/**
 * Whether two DPR values differ meaningfully (> DPR_EPSILON).
 * Mirrors the jitter guard in Scene.watchDevicePixelRatio.
 */
export function hasDprChanged(prev: number, next: number): boolean {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return true;
  return Math.abs(next - prev) > DPR_EPSILON;
}

/**
 * Convert a CSS pixel dimension to a backing-store pixel dimension.
 * Mirrors CanvasRenderer.resize: Math.round(css * dpr), max(1), NaN/Infinity guard.
 */
export function cssToBackingStore(cssPx: number, dpr: number): number {
  const safeCss = Number.isFinite(cssPx) && cssPx >= 0 ? cssPx : 0;
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const product = safeCss * safeDpr;
  if (!Number.isFinite(product)) return 1;
  return Math.max(1, Math.round(product));
}

/**
 * Compute both backing-store dimensions at once.
 * Returns `{ width, height }` in device pixels.
 */
export function computeBackingStore(
  cssWidth: number,
  cssHeight: number,
  dpr?: number,
): { width: number; height: number } {
  const resolvedDpr = dpr ?? effectiveDPR();
  return {
    width: cssToBackingStore(cssWidth, resolvedDpr),
    height: cssToBackingStore(cssHeight, resolvedDpr),
  };
}

/**
 * Guard for mobile URL-bar collapse (iOS Safari) — stage may report 0 height
 * transiently while the toolbar animates. Caller should skip resize when this
 * returns false and retry on the next ResizeObserver callback.
 */
export function isValidStageSize(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/**
 * Centered reading column max-width (Obsidian/Typora style).
 * 860 is mid of 800-900 range, balanced gutters grow on wide screens.
 */
export const CENTERED_MAX_WIDTH = 860;

/**
 * Max-width for the Markdown entity inside the stage.
 * Centered (Obsidian/Typora): caps at 860 with balanced side gutters.
 * Keeps at least 320px readable even on 390px viewports (390 - 32 = 358 >= 320).
 */
export function markdownMaxWidth(stageWidth: number): number {
  const safe = Number.isFinite(stageWidth) && stageWidth > 0 ? stageWidth : 320;
  const avail = safe - 32;
  return Math.min(CENTERED_MAX_WIDTH, Math.max(320, avail));
}

/**
 * Centered content width for a pane (editor or preview) — caps to 860 with
 * balanced gutters, DPR/mobile responsive (shrinks to fill narrow panes).
 */
export function centeredPaneWidth(
  paneWidth: number,
  gutter = 16,
  max = CENTERED_MAX_WIDTH,
): number {
  const safe = Number.isFinite(paneWidth) && paneWidth > 0 ? paneWidth : 320;
  const usable = Math.max(120, safe - 2 * gutter);
  return Math.min(max, usable);
}

/**
 * Centered X offset for a pane's content — centers max-width column inside pane.
 */
export function centeredPaneX(paneWidth: number, contentWidth: number): number {
  if (!Number.isFinite(paneWidth) || !Number.isFinite(contentWidth)) return 0;
  return Math.max(0, Math.round((paneWidth - contentWidth) / 2));
}
