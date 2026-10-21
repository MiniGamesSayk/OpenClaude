/**
 * NamePass sizes its draws and uploads to the players that have a slot, not to
 * the game's maxPlayers capacity.
 *
 * Slots are handed out contiguously from 0 and the shaders decode instances
 * player-major, so the first `slotCount` players' instances are exactly the
 * live ones. Texture uploads send only the rows written since the last draw.
 * The pass is built without its GL-heavy constructor; GL calls are recorded.
 */

import { describe, expect, it, vi } from "vitest";
import { NamePass } from "../../../../src/client/render/gl/passes/name-pass";
import { PLAYER_DATA_COLS } from "../../../../src/client/render/gl/passes/name-pass/DataTextures";
import { DebugProgram } from "../../../../src/client/render/gl/passes/name-pass/DebugProgram";
import { IconProgram } from "../../../../src/client/render/gl/passes/name-pass/IconProgram";
import { StatusIconProgram } from "../../../../src/client/render/gl/passes/name-pass/StatusIconProgram";
import { TextProgram } from "../../../../src/client/render/gl/passes/name-pass/TextProgram";
import {
  CHAR_RANGE,
  LINES_PER_PLAYER,
  MAX_CHARS,
  type PlayerSlot,
} from "../../../../src/client/render/gl/passes/name-pass/Types";
import type { PlayerStatic } from "../../../../src/client/render/types";

const MAX_PLAYERS = 64;

function playerStatic(i: number): PlayerStatic {
  return {
    smallID: i + 1,
    id: `p${i}`,
    name: `Player ${i}`,
    displayName: `Player ${i}`,
    clanTag: null,
    clientID: null,
    playerType: 0,
    team: null,
    isLobbyCreator: false,
  } as PlayerStatic;
}

interface Upload {
  tex: unknown;
  yoffset: number;
  width: number;
  height: number;
  srcOffset: number | undefined;
}

function makeGl() {
  const uploads: Upload[] = [];
  let bound: unknown = null;
  const gl = {
    TEXTURE_2D: 1,
    bindTexture: vi.fn((_target: number, tex: unknown) => {
      bound = tex;
    }),
    texSubImage2D: vi.fn(
      (
        _target: number,
        _level: number,
        _x: number,
        yoffset: number,
        width: number,
        height: number,
        _format: number,
        _type: number,
        _data: ArrayBufferView,
        srcOffset?: number,
      ) => {
        uploads.push({ tex: bound, yoffset, width, height, srcOffset });
      },
    ),
  };
  return { gl, uploads };
}

function makePass(playerCount = 0) {
  const { gl, uploads } = makeGl();
  const programs = {
    textProgram: { ready: true, draw: vi.fn() },
    statusIconProgram: { draw: vi.fn() },
    iconProgram: { draw: vi.fn() },
    debugProgram: { draw: vi.fn() },
  };
  const textures = { stringTex: {}, cursorTex: {}, playerDataTex: {} };
  const playerByID = new Map<string, PlayerStatic>();
  for (let i = 0; i < playerCount; i++) {
    playerByID.set(`p${i}`, playerStatic(i));
  }
  const pass = Object.create(NamePass.prototype) as NamePass;
  Object.assign(pass, programs, textures, {
    gl,
    maxPlayers: MAX_PLAYERS,
    settings: {
      name: { nameShadeNation: 0.2, nameShadeBot: 0.4, lerpSpeed: 1 },
      passEnabled: { nameDebug: true },
    },
    vao: {},
    playerByID,
    slots: new Map<string, PlayerSlot>(),
    slotCount: 0,
    slicePhase: 0,
    playerColors: new Map(),
    highlightOwnerID: 0,
    mouseWorldX: -1e9,
    mouseWorldY: -1e9,
    fontBase: 1,
    fontSize: 1,
    cpuPlayerData: new Float32Array(PLAYER_DATA_COLS * MAX_PLAYERS * 4),
    cpuStringData: new Uint8Array(MAX_CHARS * MAX_PLAYERS * LINES_PER_PLAYER),
    cpuCursorData: new Float32Array(MAX_CHARS * MAX_PLAYERS * LINES_PER_PLAYER),
    stringRow: new Uint8Array(MAX_CHARS),
    cursorRow: new Float32Array(MAX_CHARS),
    glyph: {
      advance: new Float32Array(CHAR_RANGE).fill(10),
      xOffset: new Float32Array(CHAR_RANGE),
      visW: new Float32Array(CHAR_RANGE).fill(8),
    },
    kernTable: new Int8Array(CHAR_RANGE * CHAR_RANGE),
    playerDataRowMin: Infinity,
    playerDataRowMax: -1,
    textRowMin: Infinity,
    textRowMax: -1,
  });
  const camera = new Float32Array(9);
  return {
    pass,
    gl,
    uploads,
    ...programs,
    ...textures,
    draw: () => pass.draw(camera, 1),
    updateNames: () => pass.updateNames(new Map(), new Map(), false),
  };
}

function internals(pass: NamePass) {
  return pass as unknown as {
    slotCount: number;
    slots: Map<string, PlayerSlot>;
    writePlayerDataRow(slot: PlayerSlot): void;
    uploadStringRow(row: number, text: string): number;
  };
}

describe("NamePass slot allocation", () => {
  it("hands out contiguous slots and only counts allocated ones", () => {
    const t = makePass(3);
    t.updateNames();
    const { slots, slotCount } = internals(t.pass);
    expect([...slots.values()].map((s) => s.index)).toEqual([0, 1, 2]);
    expect(slotCount).toBe(3);

    // A late arrival (bots join on tick 1) extends the range, in order.
    (
      t.pass as unknown as { playerByID: Map<string, PlayerStatic> }
    ).playerByID.set("p3", playerStatic(3));
    t.updateNames();
    const after = internals(t.pass);
    expect([...after.slots.values()].map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(after.slotCount).toBe(4);
  });
});

describe("NamePass.draw", () => {
  it("draws only the players that have a slot", () => {
    const t = makePass(5);
    t.updateNames();
    t.draw();

    // Every sub-program gets the allocated player count (5), not maxPlayers.
    expect(t.textProgram.draw.mock.calls[0][3]).toBe(5);
    expect(t.statusIconProgram.draw.mock.calls[0][3]).toBe(5);
    expect(t.iconProgram.draw.mock.calls[0][3]).toBe(5);
    expect(t.debugProgram.draw.mock.calls[0][3]).toBe(5);
  });

  it("uploads just the rows written since the last draw", () => {
    const t = makePass(8);
    t.updateNames();
    const { slots } = internals(t.pass);
    const byIndex = [...slots.values()];

    // Player data: slots 2 and 5 → rows 2..5.
    internals(t.pass).writePlayerDataRow(byIndex[2]);
    internals(t.pass).writePlayerDataRow(byIndex[5]);
    // Text: the name row of slot 3 (row 6) and the troop row of slot 4 (row 9).
    internals(t.pass).uploadStringRow(3 * LINES_PER_PLAYER, "Name");
    internals(t.pass).uploadStringRow(4 * LINES_PER_PLAYER + 1, "1.2K");

    t.draw();
    const rowsOf = (tex: unknown) =>
      t.uploads
        .filter((u) => u.tex === tex)
        .map((u) => [u.yoffset, u.height, u.srcOffset]);
    expect(rowsOf(t.playerDataTex)).toEqual([[2, 4, 2 * PLAYER_DATA_COLS * 4]]);
    expect(rowsOf(t.stringTex)).toEqual([[6, 4, 6 * MAX_CHARS]]);
    expect(rowsOf(t.cursorTex)).toEqual([[6, 4, 6 * MAX_CHARS]]);
    for (const u of t.uploads) {
      expect(u.width).toBe(
        u.tex === t.playerDataTex ? PLAYER_DATA_COLS : MAX_CHARS,
      );
    }

    // Nothing written since: the next draw uploads nothing.
    t.uploads.length = 0;
    t.draw();
    expect(t.uploads).toHaveLength(0);

    // A later write goes up on its own.
    internals(t.pass).writePlayerDataRow(byIndex[7]);
    t.draw();
    expect(t.uploads.map((u) => [u.yoffset, u.height])).toEqual([[7, 1]]);
  });
});

describe("name sub-program instance counts", () => {
  /** A GL whose every call is a spy; drawArraysInstanced is the one we read. */
  function spyGl() {
    const drawArraysInstanced = vi.fn();
    const gl = new Proxy({} as Record<string, unknown>, {
      get: (target, prop: string) =>
        prop === "drawArraysInstanced"
          ? drawArraysInstanced
          : (target[prop] ??= vi.fn()),
    });
    return { gl, drawArraysInstanced };
  }

  const settings = { name: {}, passEnabled: {} } as never;
  const camera = new Float32Array(9);
  const vao = {} as never;

  /** Draw once through a prototype-built program and return its instances. */
  function instancesFor(
    program: object,
    fields: Record<string, unknown>,
    draw: () => void,
  ): number {
    const { gl, drawArraysInstanced } = spyGl();
    Object.assign(program, { gl, ...fields });
    draw();
    expect(drawArraysInstanced).toHaveBeenCalledTimes(1);
    return drawArraysInstanced.mock.calls[0][3];
  }

  it("scale with the player count passed in", () => {
    const text = Object.create(TextProgram.prototype) as TextProgram;
    expect(
      instancesFor(text, { atlasReady: true, atlasTex: {}, textures: {} }, () =>
        text.draw(camera, settings, vao, 7, 1, 0, 0),
      ),
    ).toBe(7 * LINES_PER_PLAYER * MAX_CHARS);

    const icon = Object.create(IconProgram.prototype) as IconProgram;
    expect(
      instancesFor(
        icon,
        { emojiReady: true, emojiAtlasTex: {}, flagAtlas: { texture: {} } },
        () => icon.draw(camera, settings, vao, 7, 0),
      ),
    ).toBe(7 * 2); // flag + emoji

    const status = Object.create(
      StatusIconProgram.prototype,
    ) as StatusIconProgram;
    expect(
      instancesFor(
        status,
        { atlasReady: true, statusAtlasTex: {}, crownAtlas: { texture: {} } },
        () => status.draw(camera, settings, vao, 7, 0),
      ),
    ).toBe(7 * 10); // must match status-icon.vert.glsl's per-player stride

    const debug = Object.create(DebugProgram.prototype) as DebugProgram;
    expect(
      instancesFor(debug, {}, () => debug.draw(camera, settings, vao, 7)),
    ).toBe(7 * 3);
  });
});
