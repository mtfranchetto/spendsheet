/**
 * zoom.ts — the page is not something to pinch.
 *
 * It is laid out for the phone's width, so a zoom only ever shows less of it,
 * and a stray two-finger touch leaves the app scaled with nothing on screen to
 * undo it. Three layers, because no single one covers every path:
 *
 *   - the viewport tag's `maximum-scale=1, user-scalable=no` (`index.html`),
 *     which most browsers obey and which iOS Safari has ignored since iOS 10;
 *   - `touch-action: pan-x pan-y` on the root (`app.css`), which takes pinch
 *     and double-tap zoom out of the gestures the page accepts; and
 *   - this, which cancels WebKit's own `gesturestart` and `gesturechange` —
 *     the events a pinch runs through on iOS, in Safari and from the Home
 *     Screen icon alike. Cancelling them is what actually stops the pinch
 *     there.
 *
 * iOS's system-wide Zoom (Settings → Accessibility) is outside the page and
 * keeps working; that is the one to reach for when text is too small.
 */

const GESTURES = ['gesturestart', 'gesturechange'] as const;

/** Cancel WebKit's pinch events on `target` for as long as the page lives. */
export function refuseZoom(target: EventTarget): void {
  for (const type of GESTURES) {
    // Not passive: a passive listener's preventDefault is ignored.
    target.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }
}
