import { PlayerBuildableUnitType } from "@openfront/engine-api/game/GameTypes";

export interface UIState {
  attackRatio: number;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
  /** Silo bomb under a standing auto-fire order this game (null = none). */
  autoFire?: PlayerBuildableUnitType | null;
}
