/**
 * Which ticks the client presents (uploads to the renderer and ticks the HUD
 * for) when the worker sends them faster than real time: a reconnect or a
 * resume replaying the turns it missed, a tab back from the background.
 *
 * Every tick is still applied to the GameView; only the presenting is
 * skipped (GameView.update's `present`). The renderer only draws once per
 * animation frame anyway, so presenting the intermediate ticks of a batch is
 * wasted work, and while far behind a few frames a second show progress.
 */
export class CatchUpPacer {
  private lastPresentMs = -Infinity;

  constructor(
    /** While behind, present at most once per this many ms. */
    private readonly intervalMs = 200,
    /**
     * Turns pending in the worker (counting the one just run) up to which
     * the client counts as caught up and presents every batch.
     */
    private readonly caughtUpTurns = 2,
  ) {}

  /**
   * `pendingTurns`: the update's GameUpdateViewData.pendingTurns.
   * `lastOfBatch`: no further update has arrived behind this one yet.
   */
  shouldPresent(
    pendingTurns: number,
    lastOfBatch: boolean,
    nowMs: number,
  ): boolean {
    if (!lastOfBatch) return false;
    if (
      pendingTurns > this.caughtUpTurns &&
      nowMs - this.lastPresentMs < this.intervalMs
    ) {
      return false;
    }
    this.lastPresentMs = nowMs;
    return true;
  }
}
