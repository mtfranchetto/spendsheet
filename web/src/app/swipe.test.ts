import { describe, expect, it } from 'vitest';
import { dragIntent, swipeThreshold } from './swipe';

describe('swipeThreshold', () => {
  it('is 35% of the row', () => {
    expect(swipeThreshold(360)).toBeCloseTo(126);
  });

  it('never falls under 110 pixels, however narrow the row', () => {
    expect(swipeThreshold(280)).toBe(110);
  });

  it('never asks for more than 160, however wide', () => {
    expect(swipeThreshold(900)).toBe(160);
  });
});

describe('dragIntent', () => {
  it('says nothing until ten pixels have been travelled on one axis', () => {
    expect(dragIntent(9, 9)).toBeNull();
    expect(dragIntent(-9, 0)).toBeNull();
  });

  it('is a swipe when the drag is rightward and clearly sideways', () => {
    expect(dragIntent(10, 0)).toBe('swipe');
    expect(dragIntent(14, 6)).toBe('swipe');
    expect(dragIntent(14, -7)).toBe('swipe');
  });

  it('is a scroll when the drag is diagonal, though more across than down', () => {
    expect(dragIntent(10, 8)).toBe('scroll');
    expect(dragIntent(12, -7)).toBe('scroll');
  });

  it('is a scroll when vertical gets there first', () => {
    expect(dragIntent(3, 10)).toBe('scroll');
    expect(dragIntent(0, -40)).toBe('scroll');
  });

  it('is never a swipe leftward', () => {
    expect(dragIntent(-30, 0)).toBe('scroll');
  });
});
