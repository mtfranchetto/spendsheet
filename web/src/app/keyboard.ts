/**
 * keyboard.ts — a sheet that stays above the on-screen keyboard.
 *
 * iOS does not shrink the layout viewport when the keyboard comes up; it
 * shrinks the *visual* viewport and pans it over a layout that has not moved.
 * A `<dialog>` drawn from the bottom of the layout viewport therefore sits with
 * its lower half — the category list — behind the keyboard, and iOS pans again
 * every time the sheet's height changes, which is every letter typed into a
 * search that filters what is under it.
 *
 * `interactive-widget=resizes-content` in the viewport tag would say the same
 * thing in one attribute, and Safari ignores it. So the open sheet is told
 * where the visible band is, as three custom properties the CSS places it by:
 * `--vv-top`, `--vv-bottom` (from the bottom of the layout viewport) and
 * `--vv-height`.
 */

export type Band = { top: number; bottom: number; height: number };

/** The visible part of a layout viewport `layoutHeight` tall, measured from both of its edges. */
export function visibleBand(layoutHeight: number, viewport: { offsetTop: number; height: number }): Band {
  const top = Math.max(0, viewport.offsetTop);
  const height = Math.max(0, Math.min(viewport.height, layoutHeight - top));
  return { top, bottom: Math.max(0, layoutHeight - top - height), height };
}

/**
 * Keeps `el`'s `--vv-*` properties on the visible band until the returned
 * function is called. A browser with no `visualViewport` gets none, and the
 * CSS falls back to the whole screen.
 */
export function followVisibleViewport(el: HTMLElement, onChange?: () => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const place = () => {
    // `clientHeight`, not `innerHeight`: it is the layout viewport, which the keyboard does not resize.
    const band = visibleBand(document.documentElement.clientHeight, viewport);
    el.style.setProperty('--vv-top', band.top + 'px');
    el.style.setProperty('--vv-bottom', band.bottom + 'px');
    el.style.setProperty('--vv-height', band.height + 'px');
    onChange?.();
  };
  place();
  viewport.addEventListener('resize', place);
  viewport.addEventListener('scroll', place);
  return () => {
    viewport.removeEventListener('resize', place);
    viewport.removeEventListener('scroll', place);
    el.style.removeProperty('--vv-top');
    el.style.removeProperty('--vv-bottom');
    el.style.removeProperty('--vv-height');
  };
}
