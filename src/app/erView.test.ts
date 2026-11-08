import { describe, expect, it } from 'vitest';
import type { ErCheckEvent, ErPointEvent } from '../contracts';
import { checkBadge, insetPoint, markerText, offText, pointCaption, questionSubject, shortName } from './erView';

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

function check(over: Partial<ErCheckEvent> = {}): ErCheckEvent {
  return {
    kind: 'check',
    t: 1,
    source: 'coworker',
    question: 'Is Bennu in the containment bin?',
    decision: true,
    decided_by: 'registry',
    camera: 'yes',
    agree: true,
    observation: 'A dark rock sits in the bin.',
    sample_id: 'sample_2',
    sample_name: 'Bennu (NASA shape model)',
    ...over,
  };
}

describe('check_bay badge', () => {
  it('leads with the decision and who decided, then what the camera said', () => {
    expect(checkBadge(check())).toEqual({
      subject: 'Bennu in bin',
      verdict: 'YES',
      by: 'registry',
      byText: 'by registry',
      camera: 'camera: yes',
      disagree: false,
      text: 'Bennu in bin: YES (registry) · camera: yes',
    });
    expect(checkBadge(check({ camera: 'unsure', agree: null })).text).toBe('Bennu in bin: YES (registry) · camera: unsure');
    const against = checkBadge(check({ decision: false, camera: 'yes', agree: false }));
    expect(against).toMatchObject({ verdict: 'NO', camera: 'camera: yes', disagree: true });
    expect(against.text).toBe('Bennu in bin: NO (registry) · camera: yes');
  });

  it('when only the camera can answer, the camera decides and the question is the subject', () => {
    const b = checkBadge(check({ question: 'Is the deck clear of debris?', decided_by: 'camera', decision: true, camera: 'yes', agree: null, sample_id: null, sample_name: null }));
    expect(b).toMatchObject({ subject: 'Deck clear of debris', verdict: 'YES', by: 'camera', byText: 'decided by the camera', camera: null, disagree: false });
    expect(b.text).toBe('Deck clear of debris: YES (camera)');
    expect(checkBadge(check({ decided_by: 'camera', decision: false, camera: 'unsure' })).verdict).toBe('UNSURE');
    expect(checkBadge(check({ decided_by: 'camera', decision: false, camera: 'no' })).verdict).toBe('NO');
  });

  it('keeps the subject short enough for the inset', () => {
    expect(questionSubject('Are the samples spaced at least 40 mm apart on the deck?')).toBe('Samples spaced at least 40…');
    expect(questionSubject('  ')).toBe('Camera check');
    expect(checkBadge(check({ sample_name: 'Iron meteorite' })).subject).toBe('Iron meteorite in bin');
    expect(checkBadge(check({ sample_name: 'Carbonaceous chondrite fragment' })).subject).toBe('Carbonaceous… in bin');
    for (const ev of [check(), check({ camera: 'unsure', agree: null }), check({ sample_name: 'Itokawa (NASA/JAXA shape model)' })]) {
      expect(checkBadge(ev).text.length).toBeLessThanOrEqual(48);
    }
  });
});
