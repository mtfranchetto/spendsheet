/**
 * swipe.ts — swipe a row right to confirm it, press and hold for a rule.
 *
 * The numbers, and why:
 *
 * - **The threshold is a quarter of the row, between 60 and 96 pixels** — far
 *   enough that scrolling past a row never confirms it, near enough that a
 *   thumb reaches it on the narrowest phone.
 * - **Ten pixels decide the direction**, once. A drag that starts vertical is
 *   a scroll for the rest of the gesture, so a list you are scrolling never
 *   slides sideways under your thumb.
 * - **The left 24 pixels are the system's**: iOS's back swipe starts there.
 * - **A swipe is not a tap.** The click that follows a touchend is swallowed
 *   once, or releasing a swipe would also open the row.
 * - **Holding for half a second** opens the rule sheet; any movement cancels it.
 */

const SWIPE_INTENT = 10;
const EDGE_GUARD = 24;
const LONG_PRESS_MS = 500;

export function swipeThreshold(width: number): number {
  return Math.min(96, Math.max(60, width * 0.25));
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
  let dx = 0;
  let horizontal: boolean | null = null;
  let tracking = false;
  let swallow = false;
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

  button.addEventListener(
    'touchstart',
    (event) => {
      cancelHold();
      if (event.touches.length !== 1) return settle(false);
      const touch = event.touches[0];
      timer = setTimeout(() => {
        timer = null;
        swallow = true;
        on.hold();
      }, LONG_PRESS_MS);
      if (touch.clientX < EDGE_GUARD) return;
      startX = touch.clientX;
      startY = touch.clientY;
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
      const moveX = touch.clientX - startX;
      const moveY = touch.clientY - startY;
      if (horizontal === null) {
        if (Math.abs(moveX) < SWIPE_INTENT && Math.abs(moveY) < SWIPE_INTENT) return;
        cancelHold();
        horizontal = Math.abs(moveX) > Math.abs(moveY);
        if (!horizontal) {
          tracking = false;
          return;
        }
      }
      event.preventDefault();
      dx = Math.max(0, moveX);
      button.style.transform = `translateX(${dx}px)`;
      wrap().className = 'swipe sliding' + (dx >= swipeThreshold(button.offsetWidth) ? ' armed' : '');
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
      if (!tracking || !horizontal) return settle(false);
      const fired = dx >= swipeThreshold(button.offsetWidth);
      swallow = true;
      settle(true);
      if (fired) on.confirm();
    },
    { passive: true }
  );

  button.addEventListener('contextmenu', (event) => event.preventDefault());

  return () => {
    const was = swallow;
    swallow = false;
    return was;
  };
}
