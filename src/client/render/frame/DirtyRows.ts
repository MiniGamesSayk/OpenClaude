/**
 * DirtyRows — per-row change flags for a map-sized texture backing buffer.
 *
 * The code that mutates a buffer (TrailManager, RailroadCache) marks the rows
 * it touches; the pass that uploads the buffer reads them to send just those
 * rows, instead of the whole map or one min..max span that stretches across
 * every row between two distant changes. The two sides meet at the buffer
 * itself (trackDirtyRows / dirtyRowsOf), so what FrameData hands the renderer
 * stays a plain typed array.
 */

/** Clean rows tolerated between two dirty runs before they upload separately. */
export const DIRTY_ROW_MERGE_GAP = 8;

export class DirtyRows {
  /** 1 = row changed since the last clear(). Only valid within [min, max]. */
  readonly flags: Uint8Array;
  private _min = Infinity;
  private _max = -1;

  constructor(readonly rowCount: number) {
    this.flags = new Uint8Array(rowCount);
  }

  /** First dirty row (Infinity when clean). */
  get min(): number {
    return this._min;
  }

  /** Last dirty row (-1 when clean). */
  get max(): number {
    return this._max;
  }

  get isClean(): boolean {
    return this._max < 0;
  }

  mark(row: number): void {
    this.flags[row] = 1;
    if (row < this._min) this._min = row;
    if (row > this._max) this._max = row;
  }

  /** Mark every row in [min, max], clamped to the buffer. */
  markRange(min: number, max: number): void {
    const lo = Math.max(0, min);
    const hi = Math.min(this.rowCount - 1, max);
    if (hi < lo) return;
    this.flags.fill(1, lo, hi + 1);
    if (lo < this._min) this._min = lo;
    if (hi > this._max) this._max = hi;
  }

  markAll(): void {
    this.markRange(0, this.rowCount - 1);
  }

  /** Mark this buffer's rows in [min, max] that `other` has flagged. */
  merge(other: DirtyRows, min: number, max: number): void {
    const lo = Math.max(0, min);
    const hi = Math.min(this.rowCount - 1, other.rowCount - 1, max);
    for (let row = lo; row <= hi; row++) {
      if (other.flags[row] !== 0) this.mark(row);
    }
  }

  clear(): void {
    if (this._max >= 0) this.flags.fill(0, this._min, this._max + 1);
    this._min = Infinity;
    this._max = -1;
  }

  /**
   * Call `fn(firstRow, rowCount)` for each run of dirty rows. Adjacent rows
   * share a run, and so do runs separated by fewer than `maxGap` clean rows,
   * so a scatter of nearby rows costs one upload; the merged-in clean rows
   * hold current data, so re-sending them is harmless.
   */
  forEachRun(
    maxGap: number,
    fn: (firstRow: number, rowCount: number) => void,
  ): void {
    const flags = this.flags;
    const splitGap = Math.max(1, maxGap);
    let start = -1;
    let end = -1;
    for (let row = this._min; row <= this._max; row++) {
      if (flags[row] === 0) continue;
      if (start >= 0 && row - end - 1 >= splitGap) {
        fn(start, end - start + 1);
        start = row;
      } else if (start < 0) {
        start = row;
      }
      end = row;
    }
    if (start >= 0) fn(start, end - start + 1);
  }
}

const trackers = new WeakMap<object, DirtyRows>();

/** Publish `rows` as the change record of `buffer`. */
export function trackDirtyRows(buffer: ArrayBufferView, rows: DirtyRows): void {
  trackers.set(buffer, rows);
}

/** The change record of `buffer`, or undefined if its owner keeps none. */
export function dirtyRowsOf(buffer: ArrayBufferView): DirtyRows | undefined {
  return trackers.get(buffer);
}
