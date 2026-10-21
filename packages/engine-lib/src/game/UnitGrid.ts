import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerID, UnitType } from "@openfront/engine-api/game/GameTypes";
import { UnitLike, UnitPredicate } from "@openfront/engine-api/game/ReadViews";

interface Candidate<U> {
  cell: number;
  typeIdx: number;
  unit: U;
  distSquared: number;
}

export class UnitGrid<U extends UnitLike = UnitLike> {
  private grid: Map<UnitType, Set<U>>[][];
  private readonly cellSize = 100;
  /**
   * Every filed unit by type, mirroring the cells' membership. Lets a query
   * over a wide area (a SAM scanning 600 tiles for nukes) visit the handful
   * of units of the asked types instead of every cell in range.
   */
  private readonly unitsOfType = new Map<UnitType, Set<U>>();
  /** Row-major index of the cell each unit is filed in. */
  private readonly filedCell = new Map<U, number>();
  /**
   * Set once a unit got filed in two cells, or removed from a cell it isn't
   * filed in (a caller moving units without updateUnitCell). unitsOfType/filedCell
   * can't mirror that, so queries stay on the cell scan from then on.
   */
  private filingInconsistent = false;
  /** Reused for predicate checks so rejected units allocate nothing. */
  private readonly probe = { unit: null as unknown as U, distSquared: 0 };

  constructor(private gm: GameMap) {
    this.grid = Array(Math.ceil(gm.height() / this.cellSize))
      .fill(null)
      .map(() =>
        Array(Math.ceil(gm.width() / this.cellSize))
          .fill(null)
          .map(() => new Map<UnitType, Set<U>>()),
      );
  }

  /**
   * Per cell (row-major), each type's units in set order. Entry order decides
   * query result order, and it is not derivable from the units themselves.
   */
  snapshot(unitRef: (u: U) => number): [UnitType, number[]][][] {
    const out: [UnitType, number[]][][] = [];
    for (const row of this.grid) {
      for (const cell of row) {
        const entries: [UnitType, number[]][] = [];
        for (const [type, units] of cell) {
          entries.push([type, [...units].map((u) => unitRef(u))]);
        }
        out.push(entries);
      }
    }
    return out;
  }

  restoreSnapshot(
    cells: [UnitType, number[]][][],
    unit: (ref: number) => U,
  ): void {
    const width = this.grid[0]?.length ?? 0;
    cells.forEach((entries, i) => {
      const cell = this.grid[Math.floor(i / width)][i % width];
      for (const [type, refs] of entries) {
        const units = new Set(refs.map(unit));
        cell.set(type, units);
        for (const u of units) this.fileMirror(u, type, i);
      }
    });
  }

  private fileMirror(unit: U, type: UnitType, cell: number): void {
    if (this.filedCell.has(unit)) this.filingInconsistent = true;
    this.filedCell.set(unit, cell);
    let set = this.unitsOfType.get(type);
    if (set === undefined) {
      set = new Set<U>();
      this.unitsOfType.set(type, set);
    }
    set.add(unit);
  }

  // Get grid coordinates from pixel coordinates
  private getGridCoords(x: number, y: number): [number, number] {
    return [Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)];
  }

  // Add a unit to the grid
  addUnit(unit: U) {
    const tile = unit.tile();
    const [gridX, gridY] = this.getGridCoords(this.gm.x(tile), this.gm.y(tile));

    if (this.isValidCell(gridX, gridY)) {
      const type = unit.type();
      const unitSet = this.grid[gridY][gridX].get(type);
      if (unitSet === undefined) {
        this.grid[gridY][gridX].set(type, new Set<U>([unit]));
      } else if (unitSet.has(unit)) {
        return;
      } else {
        unitSet.add(unit);
      }
      this.fileMirror(unit, type, gridY * this.grid[0].length + gridX);
    }
  }

  // Remove a unit from the grid
  removeUnit(unit: U) {
    const tile = unit.tile();
    this.removeUnitByTile(unit, tile);
  }

  removeUnitByTile(unit: U, tile: TileRef) {
    const [gridX, gridY] = this.getGridCoords(this.gm.x(tile), this.gm.y(tile));

    if (this.isValidCell(gridX, gridY)) {
      const type = unit.type();
      const unitSet = this.grid[gridY][gridX].get(type);
      if (unitSet !== undefined && unitSet.delete(unit)) {
        if (this.filedCell.get(unit) === gridY * this.grid[0].length + gridX) {
          this.filedCell.delete(unit);
          this.unitsOfType.get(type)?.delete(unit);
        } else {
          this.filingInconsistent = true;
        }
      }
    }
  }

  /**
   * Move an unit to its new cell if it changed
   */
  updateUnitCell(unit: U) {
    const newTile = unit.tile();
    const oldTile = unit.lastTile();
    if (newTile === oldTile) return;
    // Runs on every unit move (hundreds of ships a tick): compare cells without
    // allocating the coordinate tuples.
    const cs = this.cellSize;
    const gridX = Math.floor(this.gm.x(oldTile) / cs);
    const gridY = Math.floor(this.gm.y(oldTile) / cs);
    const newGridX = Math.floor(this.gm.x(newTile) / cs);
    const newGridY = Math.floor(this.gm.y(newTile) / cs);
    if (gridX !== newGridX || gridY !== newGridY) {
      this.removeUnitByTile(unit, oldTile);
      this.addUnit(unit);
    }
  }

  private isValidCell(gridX: number, gridY: number): boolean {
    return (
      gridX >= 0 &&
      gridX < this.grid[0].length &&
      gridY >= 0 &&
      gridY < this.grid.length
    );
  }

  // Compute the exact cells in range of tile
  private getCellsInRange(tile: TileRef, range: number) {
    const x = this.gm.x(tile);
    const y = this.gm.y(tile);
    const cellSize = this.cellSize;
    const [gridX, gridY] = this.getGridCoords(x, y);
    const startGridX = Math.max(
      0,
      gridX - Math.ceil((range - (x % cellSize)) / cellSize),
    );
    const endGridX = Math.min(
      this.grid[0].length - 1,
      gridX + Math.ceil((range - (cellSize - (x % cellSize))) / cellSize),
    );
    const startGridY = Math.max(
      0,
      gridY - Math.ceil((range - (y % cellSize)) / cellSize),
    );
    const endGridY = Math.min(
      this.grid.length - 1,
      gridY + Math.ceil((range - (cellSize - (y % cellSize))) / cellSize),
    );

    return { startGridX, endGridX, startGridY, endGridY };
  }

  private squaredDistanceFromTile(unit: U, tile: TileRef): number {
    const x = this.gm.x(tile);
    const y = this.gm.y(tile);
    const tileX = this.gm.x(unit.tile());
    const tileY = this.gm.y(unit.tile());
    const dx = tileX - x;
    const dy = tileY - y;
    const distSquared = dx * dx + dy * dy;
    return distSquared;
  }

  // Get all units within range of a point
  // Returns [unit, distanceSquared] pairs for efficient filtering
  nearbyUnits(
    tile: TileRef,
    searchRange: number,
    types: readonly UnitType[] | UnitType,
    predicate?: UnitPredicate,
    includeUnderConstruction: boolean = false,
  ): Array<{ unit: U; distSquared: number }> {
    const { startGridX, endGridX, startGridY, endGridY } = this.getCellsInRange(
      tile,
      searchRange,
    );
    const typeList: readonly UnitType[] = Array.isArray(types)
      ? types
      : [types as UnitType];
    if (!this.filingInconsistent) {
      // Cost of the cell scan (one lookup per cell and type) against the
      // cost of visiting every unit of the asked types.
      const cellLookups =
        (endGridX - startGridX + 1) *
        (endGridY - startGridY + 1) *
        typeList.length;
      let typeUnits = 0;
      for (const type of typeList) {
        typeUnits += this.unitsOfType.get(type)?.size ?? 0;
      }
      if (typeUnits < cellLookups) {
        return this.nearbyUnitsByType(
          tile,
          searchRange,
          typeList,
          startGridX,
          endGridX,
          startGridY,
          endGridY,
          predicate,
          includeUnderConstruction,
        );
      }
    }

    const nearby: Array<{ unit: U; distSquared: number }> = [];
    const gm = this.gm;
    const x = gm.x(tile);
    const y = gm.y(tile);
    const rangeSquared = searchRange * searchRange;
    for (let cy = startGridY; cy <= endGridY; cy++) {
      for (let cx = startGridX; cx <= endGridX; cx++) {
        const cell = this.grid[cy][cx];
        for (const type of typeList) {
          const unitSet = cell.get(type);
          if (unitSet === undefined) continue;
          for (const unit of unitSet) {
            if (!unit.isActive()) continue;
            // Exclude units under construction by default (e.g., defense posts being built)
            // But include them for spacing checks
            if (!includeUnderConstruction && unit.isUnderConstruction())
              continue;
            const unitTile = unit.tile();
            const dx = gm.x(unitTile) - x;
            const dy = gm.y(unitTile) - y;
            const distSquared = dx * dx + dy * dy;
            if (distSquared > rangeSquared) continue;
            if (
              predicate !== undefined &&
              !this.accepts(predicate, unit, distSquared)
            ) {
              continue;
            }
            nearby.push({ unit, distSquared });
          }
        }
      }
    }
    return nearby;
  }

  /** Runs a predicate on the reused probe object (no allocation). */
  private accepts(
    predicate: UnitPredicate,
    unit: U,
    distSquared: number,
  ): boolean {
    const probe = this.probe;
    if (probe.unit !== null) {
      // A predicate querying the grid again: don't clobber the outer probe.
      return predicate({ unit, distSquared });
    }
    probe.unit = unit;
    probe.distSquared = distSquared;
    const keep = predicate(probe);
    // Cleared so the grid holds no stale reference between queries.
    probe.unit = null as unknown as U;
    probe.distSquared = 0;
    return keep;
  }

  /**
   * nearbyUnits by walking the asked types' units instead of the cells.
   * Returns exactly what the cell scan returns, in the same order (cell
   * row-major, then type order, then each cell set's insertion order), and
   * calls the predicate in that same order, so results — and the
   * deterministic simulation built on them — don't depend on the path taken.
   */
  private nearbyUnitsByType(
    tile: TileRef,
    searchRange: number,
    typeList: readonly UnitType[],
    startGridX: number,
    endGridX: number,
    startGridY: number,
    endGridY: number,
    predicate: UnitPredicate | undefined,
    includeUnderConstruction: boolean,
  ): Array<{ unit: U; distSquared: number }> {
    const gm = this.gm;
    const x = gm.x(tile);
    const y = gm.y(tile);
    const rangeSquared = searchRange * searchRange;
    const cols = this.grid[0].length;
    const candidates: Candidate<U>[] = [];
    for (let typeIdx = 0; typeIdx < typeList.length; typeIdx++) {
      const units = this.unitsOfType.get(typeList[typeIdx]);
      if (units === undefined) continue;
      for (const unit of units) {
        const cell = this.filedCell.get(unit)!;
        const cx = cell % cols;
        const cy = (cell - cx) / cols;
        if (
          cx < startGridX ||
          cx > endGridX ||
          cy < startGridY ||
          cy > endGridY
        ) {
          continue;
        }
        if (!unit.isActive()) continue;
        if (!includeUnderConstruction && unit.isUnderConstruction()) continue;
        const unitTile = unit.tile();
        const dx = gm.x(unitTile) - x;
        const dy = gm.y(unitTile) - y;
        const distSquared = dx * dx + dy * dy;
        if (distSquared > rangeSquared) continue;
        candidates.push({ cell, typeIdx, unit, distSquared });
      }
    }
    const nearby: Array<{ unit: U; distSquared: number }> = [];
    if (candidates.length === 0) return nearby;
    candidates.sort((a, b) => a.cell - b.cell || a.typeIdx - b.typeIdx);

    const emit = (c: Candidate<U>): void => {
      if (
        predicate === undefined ||
        this.accepts(predicate, c.unit, c.distSquared)
      ) {
        nearby.push({ unit: c.unit, distSquared: c.distSquared });
      }
    };
    for (let i = 0; i < candidates.length; ) {
      const first = candidates[i];
      let j = i + 1;
      while (
        j < candidates.length &&
        candidates[j].cell === first.cell &&
        candidates[j].typeIdx === first.typeIdx
      ) {
        j++;
      }
      if (j - i === 1) {
        emit(first);
      } else {
        // Several hits in one cell set: emit them in the set's own order.
        const group = new Map<U, Candidate<U>>();
        for (let k = i; k < j; k++) {
          group.set(candidates[k].unit, candidates[k]);
        }
        const cx = first.cell % cols;
        const cy = (first.cell - cx) / cols;
        const cellSet = this.grid[cy][cx].get(typeList[first.typeIdx])!;
        for (const unit of cellSet) {
          const c = group.get(unit);
          if (c !== undefined) emit(c);
        }
      }
      i = j;
    }
    return nearby;
  }

  private unitIsInRange(
    unit: U,
    tile: TileRef,
    rangeSquared: number,
    playerId?: PlayerID,
    includeUnderConstruction: boolean = false,
  ): boolean {
    if (!unit.isActive()) {
      return false;
    }
    // Exclude units under construction by default (e.g., defense posts being built)
    // But include them for spacing checks
    if (!includeUnderConstruction && unit.isUnderConstruction()) {
      return false;
    }
    if (playerId !== undefined && unit.owner().id() !== playerId) {
      return false;
    }
    const distSquared = this.squaredDistanceFromTile(unit, tile);
    return distSquared <= rangeSquared;
  }

  // Return true if it finds an owned specific unit in range
  hasUnitNearby(
    tile: TileRef,
    searchRange: number,
    type: UnitType,
    playerId?: PlayerID,
    includeUnderConstruction: boolean = false,
  ): boolean {
    const { startGridX, endGridX, startGridY, endGridY } = this.getCellsInRange(
      tile,
      searchRange,
    );
    const rangeSquared = searchRange * searchRange;
    for (let cy = startGridY; cy <= endGridY; cy++) {
      for (let cx = startGridX; cx <= endGridX; cx++) {
        const unitSet = this.grid[cy][cx].get(type);
        if (unitSet === undefined) continue;
        for (const unit of unitSet) {
          if (
            this.unitIsInRange(
              unit,
              tile,
              rangeSquared,
              playerId,
              includeUnderConstruction,
            )
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // Return true if any unit of the given types matches the predicate
  anyUnitNearby(
    tile: TileRef,
    searchRange: number,
    types: readonly UnitType[],
    predicate: (unit: U) => boolean,
    playerId?: PlayerID,
    includeUnderConstruction: boolean = false,
  ): boolean {
    const { startGridX, endGridX, startGridY, endGridY } = this.getCellsInRange(
      tile,
      searchRange,
    );
    const rangeSquared = searchRange * searchRange;
    for (let cy = startGridY; cy <= endGridY; cy++) {
      for (let cx = startGridX; cx <= endGridX; cx++) {
        for (const type of types) {
          const unitSet = this.grid[cy][cx].get(type);
          if (unitSet === undefined) continue;
          for (const unit of unitSet) {
            if (
              !this.unitIsInRange(
                unit,
                tile,
                rangeSquared,
                playerId,
                includeUnderConstruction,
              )
            ) {
              continue;
            }
            if (predicate(unit)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }
}
