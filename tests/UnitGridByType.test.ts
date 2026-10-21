import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { UnitLike } from "@openfront/engine-api/game/ReadViews";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { UnitGrid } from "@openfront/engine-lib/game/UnitGrid";

// UnitGrid.nearbyUnits answers wide, sparse queries (a SAM scanning for
// nukes) from a per-type index instead of scanning every cell. The result and
// the order the predicate sees units in must be exactly the cell scan's —
// the simulation is deterministic on them. The reference below rebuilds the
// cell scan from the grid's own snapshot (cells row-major, types in query
// order, each cell's units in filing order).

const W = 1000;
const H = 700;
const map = {
  width: () => W,
  height: () => H,
  x: (t: TileRef) => t % W,
  y: (t: TileRef) => Math.floor(t / W),
} as unknown as GameMap;

class FakeUnit {
  private last: TileRef;
  active = true;
  building = false;
  constructor(
    readonly id: number,
    private readonly kind: UnitType,
    private pos: TileRef,
  ) {
    this.last = pos;
  }
  type(): UnitType {
    return this.kind;
  }
  tile(): TileRef {
    return this.pos;
  }
  lastTile(): TileRef {
    return this.last;
  }
  isActive(): boolean {
    return this.active;
  }
  isUnderConstruction(): boolean {
    return this.building;
  }
  moveTo(t: TileRef): void {
    this.last = this.pos;
    this.pos = t;
  }
}

const TYPES = [
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.TradeShip,
  UnitType.Warship,
  UnitType.SAMLauncher,
];

function reference(
  grid: UnitGrid<FakeUnit & UnitLike>,
  byRef: Map<number, FakeUnit>,
  tile: TileRef,
  range: number,
  types: readonly UnitType[],
  predicate: (u: FakeUnit, d: number) => boolean,
  includeUnderConstruction: boolean,
): [number, number][] {
  const cells = grid.snapshot((u) => (u as FakeUnit).id);
  const cols = Math.ceil(W / 100);
  const x = tile % W;
  const y = Math.floor(tile / W);
  const out: [number, number][] = [];
  cells.forEach((entries, i) => {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    // Same cell bounds as getCellsInRange.
    const gx = Math.floor(x / 100);
    const gy = Math.floor(y / 100);
    if (
      cx < Math.max(0, gx - Math.ceil((range - (x % 100)) / 100)) ||
      cx > gx + Math.ceil((range - (100 - (x % 100))) / 100) ||
      cy < Math.max(0, gy - Math.ceil((range - (y % 100)) / 100)) ||
      cy > gy + Math.ceil((range - (100 - (y % 100))) / 100)
    ) {
      return;
    }
    for (const type of types) {
      const ids = entries.find(([t]) => t === type)?.[1] ?? [];
      for (const id of ids) {
        const u = byRef.get(id)!;
        if (!u.isActive()) continue;
        if (!includeUnderConstruction && u.isUnderConstruction()) continue;
        const dx = (u.tile() % W) - x;
        const dy = Math.floor(u.tile() / W) - y;
        const d = dx * dx + dy * dy;
        if (d > range * range) continue;
        if (!predicate(u, d)) continue;
        out.push([u.id, d]);
      }
    }
  });
  return out;
}

describe("UnitGrid per-type query path", () => {
  it("matches the cell scan's results and predicate order exactly", () => {
    const rand = new PseudoRandom(42);
    const grid = new UnitGrid<FakeUnit & UnitLike>(map);
    const units: FakeUnit[] = [];
    const byRef = new Map<number, FakeUnit>();
    const randTile = () => rand.nextInt(0, W * H);
    // Few nukes, many ships and launchers: both query paths get exercised.
    for (let i = 0; i < 600; i++) {
      const type =
        i % 40 === 0
          ? TYPES[i % 80 === 0 ? 0 : 1]
          : TYPES[2 + rand.nextInt(0, 3)];
      const u = new FakeUnit(i, type, randTile());
      u.building = rand.chance(10);
      units.push(u);
      byRef.set(i, u);
      grid.addUnit(u as FakeUnit & UnitLike);
    }

    for (let round = 0; round < 60; round++) {
      // Churn: moves (some across cells), deaths, removals and new units.
      for (const u of units) {
        if (!rand.chance(3)) continue;
        const dx = rand.nextInt(-40, 41);
        const dy = rand.nextInt(-40, 41);
        const nx = Math.min(W - 1, Math.max(0, (u.tile() % W) + dx));
        const ny = Math.min(H - 1, Math.max(0, Math.floor(u.tile() / W) + dy));
        u.moveTo(ny * W + nx);
        grid.updateUnitCell(u as FakeUnit & UnitLike);
      }
      const victim = units[rand.nextInt(0, units.length)];
      if (rand.chance(2)) victim.active = false;
      else grid.removeUnit(victim as FakeUnit & UnitLike);
      const born = new FakeUnit(
        units.length,
        TYPES[rand.nextInt(0, 5)],
        randTile(),
      );
      units.push(born);
      byRef.set(born.id, born);
      grid.addUnit(born as FakeUnit & UnitLike);

      for (const [range, types] of [
        [600, [UnitType.AtomBomb, UnitType.HydrogenBomb]],
        [130, [UnitType.TradeShip, UnitType.Warship]],
        [400, UnitType.HydrogenBomb],
        [250, [UnitType.SAMLauncher, UnitType.AtomBomb, UnitType.SAMLauncher]],
      ] as [number, UnitType | UnitType[]][]) {
        const center = randTile();
        const typeList = Array.isArray(types) ? types : [types];
        const includeUC = rand.chance(2);
        const seenGrid: number[] = [];
        const seenRef: number[] = [];
        const keep = (u: FakeUnit) => u.id % 3 !== 0;
        const got = grid
          .nearbyUnits(
            center,
            range,
            types,
            ({ unit }) => {
              seenGrid.push((unit as unknown as FakeUnit).id);
              return keep(unit as unknown as FakeUnit);
            },
            includeUC,
          )
          .map(({ unit, distSquared }) => [
            (unit as unknown as FakeUnit).id,
            distSquared,
          ]);
        const want = reference(
          grid,
          byRef,
          center,
          range,
          typeList,
          (u) => {
            seenRef.push(u.id);
            return keep(u);
          },
          includeUC,
        );
        expect(got).toEqual(want);
        expect(seenGrid).toEqual(seenRef);
      }
    }
  });

  it("falls back to the cell scan after a unit is filed twice", () => {
    const grid = new UnitGrid<FakeUnit & UnitLike>(map);
    const u = new FakeUnit(1, UnitType.AtomBomb, 50 * W + 50);
    grid.addUnit(u as FakeUnit & UnitLike);
    // Moved without updateUnitCell, then filed again: now in two cells.
    u.moveTo(450 * W + 450);
    grid.addUnit(u as FakeUnit & UnitLike);
    const hits = grid.nearbyUnits(300 * W + 300, 900, UnitType.AtomBomb);
    // The cell scan reports it once per cell it is filed in.
    expect(hits.length).toBe(2);
  });
});
