import type { GameRunner } from "../GameRunner";

// When a worker drain yields: after this much tick time, or this many ticks.
// Not a backlog cap: the drain reschedules itself while turns are pending.
// Live play runs one tick per drain anyway; this is for catching up, where
// each yield costs a setTimeout (clamped to 4 ms once nested) and a batch
// message. The time budget keeps cheap ticks from paying that per handful of
// ticks, and still answers queries (player actions, snapshots) between
// batches; the tick cap bounds one batch message.
export const DRAIN_BUDGET_MS = 40;
export const MAX_TICKS_PER_DRAIN = 64;

/**
 * Runs pending ticks until DRAIN_BUDGET_MS of tick time or
 * MAX_TICKS_PER_DRAIN ticks; always at least one when a turn is pending.
 * Returns how many ran.
 */
export function runTicksWithinBudget(
  gr: Pick<GameRunner, "pendingTurns" | "executeNextTick">,
  now: () => number,
  budgetMs = DRAIN_BUDGET_MS,
  maxTicks = MAX_TICKS_PER_DRAIN,
): number {
  const start = now();
  let ticksRun = 0;
  while (ticksRun < maxTicks && gr.pendingTurns() > 0) {
    if (ticksRun > 0 && now() - start >= budgetMs) break;
    if (!gr.executeNextTick(gr.pendingTurns())) break;
    ticksRun++;
  }
  return ticksRun;
}
