/**
 * pull.ts — drag down at the top of the page to read the book again.
 *
 * `installPullToRefresh` from `page.gestures.html`, with its rules intact:
 * only from the very top (a downward drag anywhere else is how you scroll
 * back up), abandoned the moment it turns sideways (the rows below will have
 * a horizontal gesture of their own), and passive throughout — at the top
 * there is nothing to scroll to, so the browser's own overscroll is what this
 * decorates rather than replaces.
 *
 * The pill is built once and mutated rather than rebuilt per `touchmove`,
 * which fires at the refresh rate. It says nothing about the fetch: it goes
 * the moment you let go, and the strip at the top reports the read.
 *
 * Its guard reads its **own** flag. The Apps Script version read a shared
 * `state.refreshing`, which became an object — always truthy — and the
 * gesture died without a sound; here the pill's state lives in this closure.
 */

const PULL_THRESHOLD = 70;
const PULL_MAX = 110;

export function installPullToRefresh(node: HTMLElement, onPull: () => void, busy: () => boolean): () => void {
  let startY = 0;
  let startX = 0;
  let pulling = false;
  let distance = 0;

  const pill = document.createElement('div');
  pill.className = 'pill';
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '↓';
  const caption = document.createElement('span');
  pill.append(arrow, caption);
  node.append(pill);

  const show = (amount: number, text: string, armed: boolean) => {
    node.hidden = false;
    caption.textContent = text;
    node.setAttribute('data-armed', armed ? 'true' : 'false');
    node.style.transform = 'translateY(' + (amount - 56) + 'px)';
    node.style.opacity = String(Math.min(1, amount / PULL_THRESHOLD));
  };

  const hide = () => {
    node.hidden = true;
    node.style.transform = '';
    node.style.opacity = '';
    node.setAttribute('data-armed', 'false');
    pulling = false;
    distance = 0;
  };

  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) return hide();
    if (window.scrollY > 0 || busy()) return;
    // A drag inside something scrolled away from its own top is that thing's scroll.
    for (let at = event.target as Node | null; at && at !== document.body; at = at.parentNode) {
      if ((at as Element).scrollTop > 0) return;
    }
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    pulling = true;
    distance = 0;
  };

  const move = (event: TouchEvent) => {
    if (!pulling) return;
    const moveY = event.touches[0].clientY - startY;
    const moveX = event.touches[0].clientX - startX;
    if (moveY <= 0 || Math.abs(moveX) > Math.abs(moveY) || window.scrollY > 0) return hide();
    // Damped past the threshold rather than clamped, so it still follows the finger.
    distance = moveY < PULL_THRESHOLD ? moveY : PULL_THRESHOLD + Math.min(PULL_MAX - PULL_THRESHOLD, (moveY - PULL_THRESHOLD) * 0.4);
    const armed = distance >= PULL_THRESHOLD;
    show(distance, armed ? 'Release to refresh' : 'Pull to refresh', armed);
  };

  const end = () => {
    if (!pulling) return;
    const fired = distance >= PULL_THRESHOLD;
    hide();
    if (fired) onPull();
  };

  const options = { passive: true };
  document.addEventListener('touchstart', start, options);
  document.addEventListener('touchmove', move, options);
  document.addEventListener('touchend', end, options);
  document.addEventListener('touchcancel', hide, options);
  hide();

  return () => {
    document.removeEventListener('touchstart', start);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('touchcancel', hide);
    pill.remove();
  };
}
