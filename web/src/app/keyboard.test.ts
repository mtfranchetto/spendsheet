import { describe, expect, it } from 'vitest';
import { visibleBand } from './keyboard';

describe('visibleBand', () => {
  it('is the whole screen with no keyboard', () => {
    expect(visibleBand(844, { offsetTop: 0, height: 844 })).toEqual({ top: 0, bottom: 0, height: 844 });
  });

  it('leaves the keyboard below it', () => {
    expect(visibleBand(844, { offsetTop: 0, height: 480 })).toEqual({ top: 0, bottom: 364, height: 480 });
  });

  it('follows a pan, keeping both edges measured from the layout viewport', () => {
    expect(visibleBand(844, { offsetTop: 120, height: 480 })).toEqual({ top: 120, bottom: 244, height: 480 });
  });

  it('never reaches past the layout viewport, mid-animation or rubber-banding', () => {
    expect(visibleBand(844, { offsetTop: 500, height: 480 })).toEqual({ top: 500, bottom: 0, height: 344 });
    expect(visibleBand(844, { offsetTop: -30, height: 480 })).toEqual({ top: 0, bottom: 364, height: 480 });
  });
});
