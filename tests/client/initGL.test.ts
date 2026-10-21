import { GLUnavailableError, initGL } from "../../src/client/render/gl/initGL";
import {
  lowSpecMode,
  setLowSpecMode,
} from "../../src/client/render/gl/LowSpec";

// WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL
const UNMASKED_RENDERER_WEBGL = 0x9246;
// GL_MAX_TEXTURE_SIZE
const MAX_TEXTURE_SIZE = 0x0d33;

// jsdom has no WebGL, so stand in a minimal fake context. When `renderer` is
// provided the fake exposes WEBGL_debug_renderer_info reporting it.
// `maxTextureSize` defaults to a typical desktop-GPU value.
function fakeContext(
  renderer?: string,
  maxTextureSize = 16384,
): WebGL2RenderingContext {
  return {
    MAX_TEXTURE_SIZE,
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info" && renderer !== undefined
        ? { UNMASKED_RENDERER_WEBGL }
        : null,
    getParameter: (param: number) =>
      param === UNMASKED_RENDERER_WEBGL
        ? renderer
        : param === MAX_TEXTURE_SIZE
          ? maxTextureSize
          : null,
  } as unknown as WebGL2RenderingContext;
}

// initGL distinguishes the accelerated request from the probe by the presence
// of failIfMajorPerformanceCaveat in the attrs, so the stub branches on it.
function stubGetContext(opts: {
  accelerated: WebGL2RenderingContext | null;
  probe: WebGL2RenderingContext | null;
}) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(((_type: string, attrs?: WebGLContextAttributes) =>
      attrs?.failIfMajorPerformanceCaveat
        ? opts.accelerated
        : opts.probe) as any);
}

describe("initGL", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLowSpecMode(false);
  });

  it("returns ok with the accelerated context when the renderer is hardware", () => {
    const accel = fakeContext("Apple M1");
    stubGetContext({ accelerated: accel, probe: fakeContext() });

    const res = initGL(document.createElement("canvas"));

    expect(res.status).toBe("ok");
    expect(res.gl).toBe(accel);
  });

  it("runs on a software renderer (accel off) in low-spec mode", () => {
    // failIfMajorPerformanceCaveat doesn't reject SwiftShader when hardware
    // acceleration is disabled in settings, so a context is still returned.
    // This fork plays on weak PCs: it keeps it instead of gating.
    const accel = fakeContext("Google SwiftShader");
    stubGetContext({ accelerated: accel, probe: null });

    const res = initGL(document.createElement("canvas"));

    expect(res.status).toBe("ok");
    expect(res.gl).toBe(accel);
    expect(lowSpecMode()).toBe(true);
  });

  it("requests the accelerated context with the caller's attrs plus the caveat flag", () => {
    const spy = stubGetContext({ accelerated: fakeContext(), probe: null });

    initGL(document.createElement("canvas"), {
      alpha: false,
      powerPreference: "high-performance",
    });

    expect(spy).toHaveBeenCalledWith("webgl2", {
      alpha: false,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: true,
    });
  });

  it("falls back to the non-accelerated context in low-spec mode", () => {
    const software = fakeContext("SwiftShader");
    stubGetContext({ accelerated: null, probe: software });

    const res = initGL(document.createElement("canvas"));

    expect(res.status).toBe("ok");
    expect(res.gl).toBe(software);
    expect(lowSpecMode()).toBe(true);
  });

  it("reports limited (but still returns the context) when MAX_TEXTURE_SIZE is below the palette size", () => {
    // privacy.resistFingerprinting (LibreWolf default, Firefox opt-in) caps
    // MAX_TEXTURE_SIZE at 2048 on an otherwise hardware-accelerated context;
    // the 4096-wide palette texture then fails silently and the map renders
    // with black areas (#4357). The player is warned but may continue.
    const accel = fakeContext("AMD Radeon", 2048);
    stubGetContext({ accelerated: accel, probe: null });

    const res = initGL(document.createElement("canvas"));

    expect(res.status).toBe("limited");
    expect(res.gl).toBe(accel);
    if (res.status === "limited") {
      expect(res.renderer).toBe("AMD Radeon");
      expect(res.maxTextureSize).toBe(2048);
    }
  });

  it("returns ok when MAX_TEXTURE_SIZE is exactly the palette size", () => {
    const accel = fakeContext("Adreno 640", 4096);
    stubGetContext({ accelerated: accel, probe: null });

    const res = initGL(document.createElement("canvas"));

    expect(res.status).toBe("ok");
    expect(res.gl).toBe(accel);
  });

  it("keeps a software renderer with capped textures (low-spec, not limited)", () => {
    stubGetContext({
      accelerated: fakeContext("Google SwiftShader", 2048),
      probe: null,
    });

    const res = initGL(document.createElement("canvas"));

    expect(res.status).toBe("ok");
  });

  it("reports unsupported when no WebGL2 context can be created at all", () => {
    stubGetContext({ accelerated: null, probe: null });

    const res = initGL(document.createElement("canvas"));

    expect(res.status).toBe("unsupported");
    expect(res.gl).toBeNull();
  });
});

describe("GLUnavailableError", () => {
  it("is an Error carrying the status and renderer", () => {
    const err = new GLUnavailableError("software", "SwiftShader");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GLUnavailableError");
    expect(err.glStatus).toBe("software");
    expect(err.renderer).toBe("SwiftShader");
  });
});
