import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game } from "../game/Game";
import { PathFinder } from "./types";

export class AirPathFinder implements PathFinder<TileRef> {
  private seed: number;

  constructor(private game: Game) {
    this.seed = game.ticks();
  }

  /** Paths are drawn from a generator re-seeded with this on every query. */
  getSeed(): number {
    return this.seed;
  }

  setSeed(seed: number): void {
    this.seed = seed;
  }

  findPath(from: TileRef | TileRef[], to: TileRef): TileRef[] | null {
    if (Array.isArray(from)) {
      throw new Error("AirPathFinder does not support multiple start points");
    }

    const random = new PseudoRandom(this.seed);
    const path: TileRef[] = [from];
    let current = from;

    while (current !== to) {
      const next = this.computeNext(current, to, random);
      if (next === current) break; // Prevent infinite loop if something breaks
      current = next;
      path.push(current);
    }

    return path;
  }

  /**
   * findPath's route, built straight into a typed array: every step closes
   * the Manhattan gap by one, so the length is known up front. Shells chasing
   * a moving target re-plan every tick; this skips the array-then-copy.
   */
  findPathTyped(from: TileRef, to: TileRef): Uint32Array {
    const random = new PseudoRandom(this.seed);
    const path = new Uint32Array(this.game.manhattanDist(from, to) + 1);
    path[0] = from;
    let n = 1;
    let current = from;
    while (current !== to && n < path.length) {
      const next = this.computeNext(current, to, random);
      if (next === current) break; // Prevent infinite loop if something breaks
      current = next;
      path[n++] = current;
    }
    if (current !== to) {
      // Unreachable by construction; fall back to the reference walk.
      return Uint32Array.from(this.findPath(from, to)!);
    }
    return n === path.length ? path : path.slice(0, n);
  }

  private computeNext(
    from: TileRef,
    to: TileRef,
    random: PseudoRandom,
  ): TileRef {
    const x = this.game.x(from);
    const y = this.game.y(from);
    const dstX = this.game.x(to);
    const dstY = this.game.y(to);

    if (x === dstX && y === dstY) {
      return to;
    }

    let nextX = x;
    let nextY = y;
    const ratio = Math.floor(1 + Math.abs(dstY - y) / (Math.abs(dstX - x) + 1));

    if (x === dstX) {
      // Can only move in Y
      nextY += y < dstY ? 1 : -1;
    } else if (y === dstY) {
      // Can only move in X
      nextX += x < dstX ? 1 : -1;
    } else {
      if (random.chance(ratio)) {
        nextX += x < dstX ? 1 : -1;
      } else {
        nextY += y < dstY ? 1 : -1;
      }
    }

    return this.game.ref(nextX, nextY);
  }
}
