/**
 * Stat.tsx — a headline number with its shape beside it.
 *
 * Both of Charts' modes open with a column of these. A card is a button only
 * when there are rows behind its figure that add up to it: a total over rows
 * of one sign opens them, while a position, a net or a ratio has no list that
 * sums to it and stays a plain card.
 */

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';

export function StatCard(props: { label: string; value: string; note?: string; thumb?: JSX.Element; onTap?: () => void }) {
  const body = () => (
    <>
      <div class="grow">
        <div class="label">{props.label}</div>
        <div class="value num">{props.value}</div>
        <Show when={props.note}>
          <div class="muted">{props.note}</div>
        </Show>
      </div>
      {props.thumb}
    </>
  );
  return (
    <div class="card">
      <Show when={props.onTap} fallback={<div class="stat">{body()}</div>}>
        <button type="button" class="stat tappable" aria-label={props.label + ' ' + props.value + ', show these transactions'} onClick={() => props.onTap?.()}>
          {body()}
          <span class="chev">›</span>
        </button>
      </Show>
    </div>
  );
}
