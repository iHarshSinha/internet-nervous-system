/**
 * Hands out frame sequence numbers, one counter per room.
 *
 * Every frame sent to a room gets the next number (1, 2, 3, ...). Clients use
 * the numbers to spot a missing frame (a gap) or one they already have (a
 * duplicate). 0 means "nothing has been sent to this room yet".
 */
export class RoomSequencer {
  private readonly seqs = new Map<string, number>();

  /** Sequence number of the last frame sent to `room`. */
  current(room: string): number {
    return this.seqs.get(room) ?? 0;
  }

  /** Reserve and return the sequence number for the next frame to `room`. */
  next(room: string): number {
    const seq = this.current(room) + 1;
    this.seqs.set(room, seq);
    return seq;
  }
}
