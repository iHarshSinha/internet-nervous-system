import { describe, expect, it } from 'vitest';
import { RoomSequencer } from './sequencer.ts';

describe('RoomSequencer', () => {
  it('starts at 0 and counts up by one', () => {
    const seq = new RoomSequencer();
    expect(seq.current('world')).toBe(0);
    expect(seq.next('world')).toBe(1);
    expect(seq.next('world')).toBe(2);
    expect(seq.current('world')).toBe(2);
  });

  it('keeps a separate counter per room', () => {
    const seq = new RoomSequencer();
    seq.next('world');
    seq.next('world');
    expect(seq.next('country:IN')).toBe(1);
    expect(seq.current('world')).toBe(2);
  });
});
