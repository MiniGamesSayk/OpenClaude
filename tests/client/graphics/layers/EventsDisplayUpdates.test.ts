/**
 * EventsDisplay should only ask Lit for an update when something shown could
 * have changed (the event list, the visibility, the betrayal countdown), and
 * should sanitize an event's HTML once when it is added, not on every render.
 */

vi.mock("lit", () => ({
  html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  LitElement: class extends EventTarget {
    requestUpdate() {}
  },
}));

vi.mock("lit/decorators.js", () => ({
  customElement: () => (clazz: unknown) => clazz,
  state: () => () => {},
  property: () => () => {},
  query: () => () => {},
}));

vi.mock("lit/directive.js", () => ({}));
vi.mock("lit/directives/unsafe-html.js", () => ({
  unsafeHTML: (s: string) => s,
}));

vi.mock("../../../../src/client/hud/layers/OnlyImages", () => ({
  onlyImages: vi.fn((s: string) => `clean(${s})`),
}));

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  getMessageTypeClasses: vi.fn(() => ""),
}));
vi.mock("@openfront/engine-lib/Format", () => ({
  renderNumber: vi.fn(),
  renderTroops: vi.fn((troops: number) => String(troops)),
}));

import { MessageType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventsDisplay } from "../../../../src/client/hud/layers/EventsDisplay";
import { onlyImages } from "../../../../src/client/hud/layers/OnlyImages";

interface Internals {
  game: unknown;
  eventBus: unknown;
  events: { description: string; sanitizedDescription?: string }[];
}

describe("EventsDisplay updates", () => {
  let ed: EventsDisplay;
  let requestUpdate: ReturnType<typeof vi.fn>;
  let traitorTicks: number;
  let tickNo: number;
  let pending: unknown;

  const myPlayer = {
    smallID: () => 1,
    displayName: () => "Me",
    isAlive: () => true,
    isTraitor: () => traitorTicks > 0,
    getTraitorRemainingTicks: () => traitorTicks,
  };

  beforeEach(() => {
    vi.mocked(onlyImages).mockClear();
    traitorTicks = 0;
    tickNo = 0;
    pending = null;
    ed = new EventsDisplay();
    requestUpdate = vi.fn();
    ed.requestUpdate = requestUpdate as never;
    (ed as unknown as Internals).eventBus = { emit: vi.fn() };
    (ed as unknown as Internals).game = {
      myPlayer: () => myPlayer,
      unit: () => undefined,
      ticks: () => tickNo,
      inSpawnPhase: () => false,
      updatesSinceLastTick: () => pending,
    };
  });

  const displayEvent = (message: string) => ({
    [GameUpdateType.DisplayEvent]: [
      {
        type: GameUpdateType.DisplayEvent,
        message,
        messageType: MessageType.ATTACK_FAILED,
        playerID: 1,
      },
    ],
  });

  it("asks for an update when the panel appears, then stays quiet on idle ticks", () => {
    ed.tick();
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    requestUpdate.mockClear();
    for (tickNo = 1; tickNo < 20; tickNo++) ed.tick();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("asks for an update when an event is added and when it expires", () => {
    ed.tick();
    requestUpdate.mockClear();

    pending = displayEvent("hello");
    tickNo = 1;
    ed.tick();
    expect(requestUpdate).toHaveBeenCalled();
    expect((ed as unknown as Internals).events).toHaveLength(1);

    pending = null;
    requestUpdate.mockClear();
    tickNo = 40;
    ed.tick();
    expect(requestUpdate).not.toHaveBeenCalled();

    // Events live for 80 ticks.
    tickNo = 81;
    ed.tick();
    expect(requestUpdate).toHaveBeenCalled();
    expect((ed as unknown as Internals).events).toHaveLength(0);
  });

  it("asks for an update when the betrayal countdown changes a second", () => {
    ed.tick();
    requestUpdate.mockClear();

    traitorTicks = 25; // 3 s
    ed.tick();
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    requestUpdate.mockClear();
    traitorTicks = 22; // still 3 s
    ed.tick();
    expect(requestUpdate).not.toHaveBeenCalled();

    traitorTicks = 20; // 2 s
    ed.tick();
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    requestUpdate.mockClear();
    traitorTicks = 0; // timer gone
    ed.tick();
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("sanitizes an event's HTML once, when it is added", () => {
    ed.tick();
    pending = displayEvent("<b>hi</b>");
    ed.tick();
    pending = null;

    expect(onlyImages).toHaveBeenCalledTimes(1);
    expect((ed as unknown as Internals).events[0].sanitizedDescription).toBe(
      "clean(<b>hi</b>)",
    );

    for (let i = 0; i < 3; i++) ed.render();
    expect(onlyImages).toHaveBeenCalledTimes(1);
  });

  it("does not sanitize events whose text is already safe", () => {
    ed.tick();
    ed.onUnitIncomingEvent({
      type: GameUpdateType.UnitIncoming,
      unitID: 7,
      message: "incoming!",
      messageType: MessageType.NUKE_INBOUND,
      playerID: 1,
    } as never);
    expect(onlyImages).not.toHaveBeenCalled();
    expect(
      (ed as unknown as Internals).events[0].sanitizedDescription,
    ).toBeUndefined();
  });
});
