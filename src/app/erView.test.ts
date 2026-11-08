import { describe, expect, it } from 'vitest';
import type { ErPointEvent } from '../contracts';
import { insetPoint, markerText, offText, pointCaption, shortName } from './erView';

function point(over: Partial<ErPointEvent> = {}): ErPointEvent {
  return {
    kind: 'point',
    t: 1,
    source: 'coworker',
    label: 'the Bennu sample',
    point_yx: [612, 571],
    sample_id: 'sample_2',
    sample_name: 'Bennu (NASA shape model)',
    found_mm: [57, -156, 16],
    error_mm: 1.5,
    truth_mm: [56, -155, 16],
    truth_yx: [613.2, 569.5],
    ...over,
  };
}

describe('point_at caption', () => {
  it('names the sample without its parenthetical and gives the miss in mm', () => {
    expect(shortName('Bennu (NASA shape model)')).toBe('Bennu');
    expect(shortName('Itokawa (NASA/JAXA shape model)')).toBe('Itokawa');
    expect(shortName('Iron meteorite')).toBe('Iron meteorite');
    expect(shortName('(odd)')).toBe('(odd)');
    expect(offText(1.46)).toBe('1.5 mm off');
    expect(offText(0)).toBe('0.0 mm off');
    expect(offText(9.96)).toBe('10 mm off');
    expect(offText(23.4)).toBe('23 mm off');
    expect(pointCaption(point())).toEqual({ who: 'Robotics-ER', what: 'Bennu', off: '1.5 mm off', text: 'Robotics-ER · Bennu · 1.5 mm off' });
    expect(markerText(point())).toBe('Robotics-ER · 1.5 mm off');
  });

  it('says so when the point matches no sample or misses the deck', () => {
    const loose = point({ sample_id: null, sample_name: null, error_mm: null, truth_mm: null, truth_yx: null, label: 'the antenna boom' });
    expect(pointCaption(loose).text).toBe('Robotics-ER · antenna boom · no registry match');
    expect(markerText(loose)).toBe('Robotics-ER · antenna boom');
    expect(pointCaption(point({ found_mm: null, error_mm: null })).off).toBe('off the deck');
    expect(pointCaption(point({ sample_name: null, label: 'a very long description of the thing to find' })).what).toBe('very long description…');
  });
});

describe('inset mapping', () => {
  it('maps a bay-camera [y, x] point to the SVG frame (x across, y down) and clamps it to the image', () => {
    expect(insetPoint([612, 571])).toEqual({ x: 571, y: 612, inside: true });
    expect(insetPoint([0, 1000])).toEqual({ x: 1000, y: 0, inside: true });
    expect(insetPoint([-20, 400])).toEqual({ x: 400, y: 0, inside: false });
    expect(insetPoint([500, 1040])).toEqual({ x: 1000, y: 500, inside: false });
  });
});
