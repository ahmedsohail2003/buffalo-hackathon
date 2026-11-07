import { afterEach, describe, expect, it } from 'vitest';
import { base64Bytes, egressSnapshot, egressSummary, formatBytes, onEgress, recordEgress, resetEgress, utf8Bytes } from './egress';

afterEach(() => resetEgress());

describe('egress counter', () => {
  it('starts empty', () => {
    expect(egressSnapshot().requests).toBe(0);
    expect(egressSummary(egressSnapshot())).toBe('nothing yet');
  });

  it('accumulates by kind and destination and notifies', () => {
    let notified = 0;
    onEgress(() => notified++);
    recordEgress({ dest: 'gemini', kind: 'image', bytes: 61_000 });
    recordEgress({ dest: 'gemini', kind: 'text', bytes: 2_400 });
    recordEgress({ dest: 'elevenlabs', kind: 'text', bytes: 300 });
    const s = egressSnapshot();
    expect(notified).toBe(3);
    expect(s.requests).toBe(3);
    expect(s.bytes).toBe(63_700);
    expect(s.images).toBe(1);
    expect(s.byDest.gemini).toEqual({ requests: 2, bytes: 63_400 });
    expect(s.byDest.elevenlabs).toEqual({ requests: 1, bytes: 300 });
    expect(egressSummary(s)).toBe('1 bay frame (61 kB) · 2.7 kB text');
  });

  it('measures payloads', () => {
    expect(utf8Bytes('héllo')).toBe(6);
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1500)).toBe('1.5 kB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
  });
});
