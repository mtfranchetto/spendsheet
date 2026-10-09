/**
 * swipe.ts — swipe a row right to confirm it, press and hold for a rule.
 *
 * The numbers, and why:
 *
 * - **The threshold is 35% of the row, between 110 and 160 pixels**, the
 *   distance a list on the phone itself asks for before a swipe acts rather
 *   than reveals. A confirmation is a write, so it takes a drag nobody makes
 *   by accident; a thumb still reaches it from the left half of the narrowest
 *   phone.
 * - **Distance is the only thing that confirms.** There is no flick: a fast
 *   short drag is exactly what a scroll that wandered sideways looks like.
 *   What is green when the finger lifts is what happens, and dragging back
 *   under the threshold is how you change your mind.
 * - **Ten pixels decide the direction, once, and sideways has to win clearly**
 *   — rightward, and at least twice as far across as down. A thumb scrolls in
 *   an arc, so "more across than down" is true of the first ten pixels of a
 *   great many scrolls; a drag that fails the test is a scroll for the rest
 *   of the gesture, and a list you are scrolling never slides sideways under
 *   your thumb.
 * - **The page decides before this does.** A `touchmove` that cannot be
 *   cancelled, or a page that has moved since the finger landed, means the
 *   browser has already taken the gesture as a scroll, and a row sliding
 *   under a scrolling list is two answers to one drag.
 * - **Travel is counted from where the direction was decided**, not from where
 *   the finger landed, so the row starts under the thumb instead of jumping
 *   the ten pixels it took to be sure.
 * - **The left 24 pixels are the system's**: iOS's back swipe starts there.
 * - **A second finger ends it.** Two touches are a pinch or a mistake, and
 *   neither confirms a row.
 * - **A swipe is not a tap.** The click a touch leaves behind is swallowed —
 *   but only one that arrives right behind it. WebKit sends no click at all
 *   after a drag, so a flag waiting for one would eat the next real tap on
 *   the row instead, however much later it came.
 * - **Holding for half a second** opens the rule sheet; any movement cancels
 *   it, and once it has opened the touch is spent.
 */

const SWIPE_INTENT = 10;
const SWIPE_DOMINANCE = 2;
const EDGE_GUARD = 24;
const LONG_PRESS_MS = 500;
const GHOST_CLICK_MS = 400;

export function swipeThreshold(width: number): number {
  return Math.min(160, Math.max(110, width * 0.35));
}

/** What a drag of this much is: a swipe, a scroll, or too short to say. */
export function dragIntent(moveX: number, moveY: number): 'swipe' | 'scroll' | null {
  if (Math.abs(moveX) < SWIPE_INTENT && Math.abs(moveY) < SWIPE_INTENT) return null;
  return moveX >= SWIPE_INTENT && moveX >= Math.abs(moveY) * SWIPE_DOMINANCE ? 'swipe' : 'scroll';
}

export type RowGestures = {
  /** Released past the threshold. */
  confirm: () => void;
  /** Held still for half a second. */
  hold: () => void;
};

/** Wire both gestures onto `button`, whose parent is its `.swipe` wrapper. Returns whether the next click belongs to a gesture. */
export function rowGestures(button: HTMLElement, on: RowGestures): () => boolean {
  // Looked up when a gesture runs, so it can be wired from a ref before the row is in its wrapper.
  const wrap = () => button.parentElement as HTMLElement;
  let startX = 0;
  let startY = 0;
  let startScroll = 0;
  let lockX = 0;
  let dx = 0;
  let horizontal: boolean | null = null;
  let tracking = false;
  let gestured = false;
  let swallowUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelHold = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const settle = (animate: boolean) => {
    wrap().className = 'swipe' + (animate ? ' springing' : '');
    button.style.transform = '';
    dx = 0;
    horizontal = null;
    tracking = false;
  };
  const armed = () => dx >= swipeThreshold(button.offsetWidth);

  button.addEventListener(
    'touchstart',
    (event) => {
      cancelHold();
      if (event.touches.length !== 1) return settle(horizontal === true);
      const touch = event.touches[0];
      gestured = false;
      timer = setTimeout(() => {
        timer = null;
        gestured = true;
        tracking = false;
        on.hold();
      }, LONG_PRESS_MS);
      if (touch.clientX < EDGE_GUARD) return;
      startX = touch.clientX;
      startY = touch.clientY;
      startScroll = window.scrollY;
      dx = 0;
      horizontal = null;
      tracking = true;
      wrap().className = 'swipe';
    },
    { passive: true }
  );

  button.addEventListener(
    'touchmove',
    (event) => {
      if (!tracking) return cancelHold();
      const touch = event.touches[0];
      if (horizontal === null) {
        const intent = dragIntent(touch.clientX - startX, touch.clientY - startY);
        if (intent === null) return;
        cancelHold();
        if (intent === 'scroll' || !event.cancelable || window.scrollY !== startScroll) {
          tracking = false;
          return;
        }
        horizontal = true;
        lockX = touch.clientX;
      }
      if (event.cancelable) event.preventDefault();
      dx = Math.max(0, touch.clientX - lockX);
      button.style.transform = `translateX(${dx}px)`;
      wrap().className = 'swipe sliding' + (armed() ? ' armed' : '');
    },
    { passive: false }
  );

  button.addEventListener(
    'touchcancel',
    () => {
      cancelHold();
      settle(true);
    },
    { passive: true }
  );

  button.addEventListener(
    'touchend',
    () => {
      cancelHold();
      const swiped = tracking && horizontal === true;
      const fired = swiped && armed();
      if (swiped || gestured) swallowUntil = performance.now() + GHOST_CLICK_MS;
      gestured = false;
      // Anything else has settled already, and settling again would cut a spring short.
      if (tracking) settle(swiped);
      if (fired) on.confirm();
    },
    { passive: true }
  );

  button.addEventListener('contextmenu', (event) => event.preventDefault());

  return () => {
    const was = performance.now() < swallowUntil;
    swallowUntil = 0;
    return was;
  };
}
