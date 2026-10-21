/**
 * SAMRadiusPass only rebuilds its circles/arcs while the overlay is visible.
 *
 * Structure, ally, local-player and color-mode changes just mark the instance
 * buffer stale; the (quadratic) circle-union work happens in draw(), once per
 * draw however many changes arrived. The pass runs against a recording GL
 * stub, so what reaches the instance buffer is observable.
 */

import { describe, expect, it, vi } from "vitest";
import { SAMRadiusPass } from "../../../../src/client/render/gl/passes/SamRadiusPass";
import { createRenderSettings } from "../../../../src/client/render/gl/RenderSettings";
import type { UnitState } from "../../../../src/client/render/types";
import { UT_SAM_LAUNCHER } from "../../../../src/client/render/types";

const MAP_W = 500;
const FLOATS_PER_INSTANCE = 10;

function makeGl() {
  const uploads: Float32Array[] = [];
  const draws: number[] = [];
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    createProgram: () => ({}),
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    useProgram: () => {},
    deleteShader: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: vi.fn(
      (
        _target: number,
        _offset: number,
        data: Float32Array,
        srcOffset: number,
        length: number,
      ) => {
        uploads.push(data.slice(srcOffset, srcOffset + length));
      },
    ),
    createVertexArray: () => ({}),
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    getUniformLocation: () => ({}),
    uniform1f: () => {},
    uniformMatrix3fv: () => {},
    drawArraysInstanced: vi.fn(
      (_mode: number, _first: number, _count: number, instances: number) => {
        draws.push(instances);
      },
    ),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, uploads, draws };
}

function sam(id: number, ownerID: number, x: number, y: number): UnitState {
  const pos = y * MAP_W + x;
  return {
    id,
    ownerID,
    unitType: UT_SAM_LAUNCHER,
    pos,
    lastPos: pos,
    isActive: true,
    level: 1,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
  } as UnitState;
}

const CAMERA = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Two SAMs far apart so neither circle covers any of the other. */
function twoSams(): Map<number, UnitState> {
  return new Map([
    [1, sam(1, 1, 50, 50)],
    [2, sam(2, 2, 400, 400)],
  ]);
}

function makePass() {
  const rig = makeGl();
  const pass = new SAMRadiusPass(rig.gl, MAP_W, createRenderSettings());
  const collect = vi.spyOn(
    pass as unknown as { collectSAMCircles(...args: unknown[]): unknown },
    "collectSAMCircles",
  );
  return { ...rig, pass, collect };
}

describe("SAMRadiusPass lazy rebuild", () => {
  it("does no geometry work while hidden", () => {
    const { pass, collect, uploads, draws } = makePass();
    pass.setLocalPlayer(1);
    pass.updateStructures(twoSams());
    for (let i = 0; i < 5; i++) {
      pass.setAllies(new Set([2]));
      pass.setTick(i);
      pass.draw(CAMERA);
    }
    expect(collect).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
    expect(draws).toHaveLength(0);
  });

  it("builds on the first visible draw, with the latest state", () => {
    const { pass, collect, uploads, draws } = makePass();
    pass.setLocalPlayer(1);
    pass.updateStructures(twoSams());
    pass.setAllies(new Set([2])); // arrives after the structures
    pass.setVisible(true);
    pass.draw(CAMERA);

    expect(collect).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
    expect(draws).toEqual([2]);

    // One full-circle instance per SAM: self (owner 1) green, ally yellow.
    const data = uploads[0];
    expect(data).toHaveLength(2 * FLOATS_PER_INSTANCE);
    const rgb = (i: number) => Array.from(data.slice(i * 10 + 3, i * 10 + 6));
    expect(rgb(0)).toEqual([0, 1, 0]);
    expect(rgb(1)).toEqual([1, 1, 0]);
    expect(data[0 * 10 + 7]).toBe(0); // arcStart
    expect(data[0 * 10 + 8]).toBeCloseTo(Math.PI * 2); // arcEnd
  });

  it("rebuilds once per draw however many changes arrived", () => {
    const { pass, collect, uploads } = makePass();
    pass.setLocalPlayer(1);
    pass.updateStructures(twoSams());
    pass.setVisible(true);
    pass.draw(CAMERA);
    expect(collect).toHaveBeenCalledTimes(1);

    // Nothing changed: draws reuse the uploaded instances.
    pass.draw(CAMERA);
    pass.draw(CAMERA);
    expect(collect).toHaveBeenCalledTimes(1);

    // Several changes before the next draw coalesce into one rebuild that
    // reflects all of them.
    pass.setAllies(new Set([2]));
    pass.updateStructures(new Map([[1, sam(1, 1, 50, 50)]]));
    pass.setAllies(new Set());
    pass.draw(CAMERA);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toHaveLength(1 * FLOATS_PER_INSTANCE);
  });

  it("catches up when the overlay is shown after changes while hidden", () => {
    const { pass, collect, draws } = makePass();
    pass.setLocalPlayer(1);
    pass.updateStructures(twoSams());
    pass.setVisible(true);
    pass.draw(CAMERA);
    pass.setVisible(false);

    // Structures change while hidden...
    pass.updateStructures(new Map([[1, sam(1, 1, 50, 50)]]));
    pass.draw(CAMERA);
    expect(collect).toHaveBeenCalledTimes(1);

    // ...and the overlay shows the new set as soon as it is visible again.
    pass.setVisible(true);
    pass.draw(CAMERA);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(draws).toEqual([2, 1]);
  });
});
