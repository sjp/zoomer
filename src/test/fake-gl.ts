/**
 * A recording stand-in for `WebGL2RenderingContext`, for tests that run effects and
 * GL helpers without a browser. It compiles nothing and draws nothing, but it tracks
 * the state and objects that effects get wrong most often:
 *
 * - every object created and deleted, so a test can check `dispose` frees them all
 *   (and that nothing is deleted twice or used after deletion);
 * - the current program and the program each uniform location belongs to, so a
 *   uniform write while another program is bound is reported;
 * - framebuffer, vertex array, buffer and texture bindings, blend equation,
 *   enabled caps, viewport, clear colour and colour mask, readable through
 *   `getParameter` / `isEnabled` like a real context.
 *
 * Misuse is collected in `errors` rather than thrown, so a test can run a whole
 * effect and then assert that the list is empty. Enums are distinct small integers
 * (`NO_ERROR` and `NONE` are 0); `enumName` maps one back to its name.
 */

export interface FakeGlOptions {
  /** Extensions `getExtension` returns an object for. Defaults to none. */
  extensions?: readonly string[];
  /**
   * Fails the shader compile with this zero-based index (counting every
   * `compileShader` call), to test that a throwing `create` cleans up.
   */
  failCompileAt?: number;
  /** Internal formats whose framebuffers report incomplete. */
  unrenderable?: readonly string[];
  /** Records every method call in `calls`. Defaults to false. */
  record?: boolean;
}

export interface FakeObject {
  readonly kind: string;
  readonly id: number;
  deleted: boolean;
}

interface FakeLocation {
  readonly program: FakeObject;
  readonly name: string;
}

export interface FakeGlState {
  program: FakeObject | null;
  drawFramebuffer: FakeObject | null;
  readFramebuffer: FakeObject | null;
  vertexArray: FakeObject | null;
  /** Buffer bound to each target, by target name. */
  buffers: Map<string, FakeObject | null>;
  activeTexture: number;
  /** 2D texture bound to each texture unit. */
  textures: Map<number, FakeObject | null>;
  enabled: Set<string>;
  blendEquationRgb: string;
  blendEquationAlpha: string;
  viewport: [number, number, number, number];
  clearColor: [number, number, number, number];
  colorMask: [boolean, boolean, boolean, boolean];
}

export interface FakeGl {
  gl: WebGL2RenderingContext;
  state: FakeGlState;
  /** Misuse found so far, as readable messages. */
  errors: string[];
  /** Every method call, when `record` is set. Enum arguments stay numbers. */
  calls: { name: string; args: unknown[] }[];
  /** Objects created and not yet deleted. */
  live: () => FakeObject[];
  /** Number of objects created so far, by kind ("Texture", "Program" and so on). */
  created: Map<string, number>;
  /** Number of `drawArrays*` / `drawElements*` calls so far. */
  draws: () => number;
  enumName: (value: unknown) => string;
}

/** WebGL enums code may compare against `getError` or a missing value. */
const ZERO_ENUMS = new Set(["NO_ERROR", "NONE", "ZERO", "POINTS"]);

export function createFakeGl(options: FakeGlOptions = {}): FakeGl {
  const enumValues = new Map<string, number>();
  const enumNames = new Map<number, string>();
  const enumOf = (name: string): number => {
    let value = enumValues.get(name);
    if (value === undefined) {
      value = ZERO_ENUMS.has(name) ? 0 : 0x10000 + enumValues.size;
      enumValues.set(name, value);
      if (value !== 0) enumNames.set(value, name);
    }
    return value;
  };
  const enumName = (value: unknown): string =>
    typeof value === "number" ? (enumNames.get(value) ?? `0x${value.toString(16)}`) : String(value);

  // Texture units are consecutive, as `TEXTURE0 + i` relies on.
  for (let i = 0; i < 32; i++) enumOf(`TEXTURE${String(i)}`);

  const errors: string[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  const objects: FakeObject[] = [];
  const created = new Map<string, number>();
  let compiles = 0;
  let draws = 0;
  /** Internal format of each texture's storage, for framebuffer completeness. */
  const textureFormats = new Map<FakeObject, string>();
  const attachments = new Map<FakeObject, FakeObject>();
  const bufferSizes = new Map<FakeObject, number>();
  const shaderFailed = new Set<FakeObject>();

  const state: FakeGlState = {
    program: null,
    drawFramebuffer: null,
    readFramebuffer: null,
    vertexArray: null,
    buffers: new Map(),
    activeTexture: 0,
    textures: new Map(),
    enabled: new Set(),
    blendEquationRgb: "FUNC_ADD",
    blendEquationAlpha: "FUNC_ADD",
    viewport: [0, 0, 300, 150],
    clearColor: [0, 0, 0, 0],
    colorMask: [true, true, true, true],
  };

  const create = (kind: string) => () => {
    const obj: FakeObject = { kind, id: objects.length + 1, deleted: false };
    objects.push(obj);
    created.set(kind, (created.get(kind) ?? 0) + 1);
    return obj;
  };

  /** Checks `obj` is null or a live object of `kind`, reporting misuse under `call`. */
  const check = (call: string, kind: string, obj: unknown): obj is FakeObject | null => {
    if (obj === null) return true;
    const o = obj as FakeObject;
    if (typeof o !== "object" || o.kind !== kind) {
      const got = typeof o === "object" ? `${o.kind} ${String(o.id)}` : typeof obj;
      errors.push(`${call}: expected a ${kind}, got ${got}`);
      return false;
    }
    if (o.deleted) {
      errors.push(`${call}: ${kind} ${String(o.id)} was already deleted`);
      return false;
    }
    return true;
  };

  const del = (kind: string) => (obj: unknown) => {
    if (obj === null || obj === undefined) return;
    if (!check(`delete${kind}`, kind, obj)) return;
    obj.deleted = true;
    // As in WebGL, deleting a bound object unbinds it (a current program stays
    // in use until another is bound).
    if (state.drawFramebuffer === obj) state.drawFramebuffer = null;
    if (state.readFramebuffer === obj) state.readFramebuffer = null;
    if (state.vertexArray === obj) state.vertexArray = null;
    for (const map of [state.buffers, state.textures] as Map<unknown, FakeObject | null>[]) {
      for (const [key, bound] of map) if (bound === obj) map.set(key, null);
    }
  };

  const bindFramebuffer = (target: number, fb: FakeObject | null) => {
    if (!check("bindFramebuffer", "Framebuffer", fb)) return;
    const t = enumName(target);
    if (t === "FRAMEBUFFER" || t === "DRAW_FRAMEBUFFER") state.drawFramebuffer = fb;
    if (t === "FRAMEBUFFER" || t === "READ_FRAMEBUFFER") state.readFramebuffer = fb;
  };

  const uniform = (name: string) => (loc: FakeLocation | null) => {
    if (loc === null) return;
    if (state.program === null) errors.push(`${name}(${loc.name}) with no program bound`);
    else if (loc.program !== state.program) {
      errors.push(
        `${name}(${loc.name}) belongs to program ${String(loc.program.id)} but program ${String(state.program.id)} is bound`,
      );
    }
  };

  const draw = (name: string) => () => {
    draws++;
    if (state.program === null) errors.push(`${name} with no program bound`);
  };

  const methods: Record<string, (...args: never[]) => unknown> = {
    isContextLost: () => false,
    getError: () => 0,
    getExtension: (name: string) => (options.extensions?.includes(name) ? {} : null),
    getSupportedExtensions: () => [...(options.extensions ?? [])],

    createShader: create("Shader"),
    createProgram: create("Program"),
    createBuffer: create("Buffer"),
    createTexture: create("Texture"),
    createFramebuffer: create("Framebuffer"),
    createRenderbuffer: create("Renderbuffer"),
    createVertexArray: create("VertexArray"),
    createQuery: create("Query"),
    deleteShader: del("Shader"),
    deleteProgram: del("Program"),
    deleteBuffer: del("Buffer"),
    deleteTexture: del("Texture"),
    deleteFramebuffer: del("Framebuffer"),
    deleteRenderbuffer: del("Renderbuffer"),
    deleteVertexArray: del("VertexArray"),
    deleteQuery: del("Query"),

    compileShader: (shader: FakeObject) => {
      check("compileShader", "Shader", shader);
      if (compiles++ === options.failCompileAt) shaderFailed.add(shader);
    },
    getShaderParameter: (shader: FakeObject) => !shaderFailed.has(shader),
    getShaderInfoLog: () => "fake compile error",
    attachShader: (program: FakeObject, shader: FakeObject) => {
      check("attachShader", "Program", program);
      check("attachShader", "Shader", shader);
    },
    linkProgram: (program: FakeObject) => check("linkProgram", "Program", program),
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    useProgram: (program: FakeObject | null) => {
      if (check("useProgram", "Program", program)) state.program = program;
    },
    getUniformLocation: (program: FakeObject | null, name: string): FakeLocation | null =>
      check("getUniformLocation", "Program", program) && program ? { program, name } : null,
    getAttribLocation: () => 0,

    bindFramebuffer,
    bindVertexArray: (vao: FakeObject | null) => {
      if (check("bindVertexArray", "VertexArray", vao)) state.vertexArray = vao;
    },
    bindBuffer: (target: number, buffer: FakeObject | null) => {
      if (check("bindBuffer", "Buffer", buffer)) state.buffers.set(enumName(target), buffer);
    },
    bufferData: (target: number, data: number | ArrayBufferView) => {
      const buffer = state.buffers.get(enumName(target));
      if (!buffer) return void errors.push(`bufferData(${enumName(target)}) with no buffer bound`);
      bufferSizes.set(buffer, typeof data === "number" ? data : data.byteLength);
    },
    bufferSubData: (
      target: number,
      offset: number,
      data: ArrayBufferView,
      srcOffset = 0,
      length?: number,
    ) => {
      const buffer = state.buffers.get(enumName(target));
      if (!buffer) return void errors.push(`bufferSubData(${enumName(target)}) with no buffer`);
      const bytesPer = "BYTES_PER_ELEMENT" in data ? (data.BYTES_PER_ELEMENT as number) : 1;
      const count = length ?? data.byteLength / bytesPer - srcOffset;
      const size = bufferSizes.get(buffer) ?? 0;
      if (offset + count * bytesPer > size || srcOffset + count > data.byteLength / bytesPer) {
        errors.push(
          `bufferSubData writes ${String(count * bytesPer)} bytes at ${String(offset)} of ${String(size)}`,
        );
      }
    },
    activeTexture: (unit: number) => {
      state.activeTexture = unit - enumOf("TEXTURE0");
    },
    bindTexture: (target: number, texture: FakeObject | null) => {
      if (!check("bindTexture", "Texture", texture)) return;
      if (enumName(target) === "TEXTURE_2D") state.textures.set(state.activeTexture, texture);
    },
    texStorage2D: (_target: number, _levels: number, format: number) => {
      const texture = state.textures.get(state.activeTexture);
      if (texture) textureFormats.set(texture, enumName(format));
      else errors.push("texStorage2D with no texture bound");
    },
    texImage2D: (_target: number, _level: number, format: number) => {
      const texture = state.textures.get(state.activeTexture);
      if (texture) textureFormats.set(texture, enumName(format));
      else errors.push("texImage2D with no texture bound");
    },
    texSubImage2D: () => {
      if (!state.textures.get(state.activeTexture)) errors.push("texSubImage2D with no texture");
    },
    framebufferTexture2D: (
      _target: number,
      _attachment: number,
      _texTarget: number,
      texture: FakeObject | null,
    ) => {
      if (!state.drawFramebuffer) errors.push("framebufferTexture2D on the default framebuffer");
      else if (check("framebufferTexture2D", "Texture", texture) && texture) {
        attachments.set(state.drawFramebuffer, texture);
      }
    },
    checkFramebufferStatus: () => {
      const texture = state.drawFramebuffer && attachments.get(state.drawFramebuffer);
      const format = texture ? textureFormats.get(texture) : undefined;
      const ok = format !== undefined && !options.unrenderable?.includes(format);
      return enumOf(ok ? "FRAMEBUFFER_COMPLETE" : "FRAMEBUFFER_INCOMPLETE_ATTACHMENT");
    },

    enable: (cap: number) => void state.enabled.add(enumName(cap)),
    disable: (cap: number) => void state.enabled.delete(enumName(cap)),
    isEnabled: (cap: number) => state.enabled.has(enumName(cap)),
    blendEquation: (mode: number) => {
      state.blendEquationRgb = state.blendEquationAlpha = enumName(mode);
    },
    blendEquationSeparate: (rgb: number, alpha: number) => {
      state.blendEquationRgb = enumName(rgb);
      state.blendEquationAlpha = enumName(alpha);
    },
    viewport: (x: number, y: number, w: number, h: number) => {
      state.viewport = [x, y, w, h];
    },
    clearColor: (r: number, g: number, b: number, a: number) => {
      state.clearColor = [r, g, b, a];
    },
    colorMask: (r: boolean, g: boolean, b: boolean, a: boolean) => {
      state.colorMask = [r, g, b, a];
    },
    getParameter: (pname: number) => {
      switch (enumName(pname)) {
        case "CURRENT_PROGRAM":
          return state.program;
        case "FRAMEBUFFER_BINDING":
        case "DRAW_FRAMEBUFFER_BINDING":
          return state.drawFramebuffer;
        case "READ_FRAMEBUFFER_BINDING":
          return state.readFramebuffer;
        case "TEXTURE_BINDING_2D":
          return state.textures.get(state.activeTexture) ?? null;
        case "VERTEX_ARRAY_BINDING":
          return state.vertexArray;
        case "ACTIVE_TEXTURE":
          return enumOf("TEXTURE0") + state.activeTexture;
        case "VIEWPORT":
          return new Int32Array(state.viewport);
        case "COLOR_CLEAR_VALUE":
          return new Float32Array(state.clearColor);
        case "COLOR_WRITEMASK":
          return [...state.colorMask];
        case "MAX_TEXTURE_SIZE":
        case "MAX_RENDERBUFFER_SIZE":
          return 16384;
        default:
          errors.push(`getParameter(${enumName(pname)}) is not supported by the fake`);
          return null;
      }
    },

    drawArrays: draw("drawArrays"),
    drawArraysInstanced: draw("drawArraysInstanced"),
    drawElements: draw("drawElements"),
    drawElementsInstanced: draw("drawElementsInstanced"),
  };
  for (const name of [
    "uniform1f",
    "uniform2f",
    "uniform3f",
    "uniform4f",
    "uniform1i",
    "uniform2i",
    "uniform3i",
    "uniform4i",
    "uniform1ui",
    "uniform2ui",
    "uniform3ui",
    "uniform4ui",
    "uniform1fv",
    "uniform2fv",
    "uniform3fv",
    "uniform4fv",
    "uniform1iv",
    "uniform2iv",
    "uniform3iv",
    "uniform4iv",
    "uniformMatrix2fv",
    "uniformMatrix3fv",
    "uniformMatrix4fv",
  ]) {
    methods[name] = uniform(name);
  }

  const noop = () => undefined;
  const gl = new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key !== "string" || key === "then") return undefined;
        if (/^[A-Z][A-Z0-9_]*$/.test(key)) return enumOf(key);
        const method = (methods[key] as ((...args: unknown[]) => unknown) | undefined) ?? noop;
        if (!options.record) return method;
        return (...args: unknown[]) => {
          calls.push({ name: key, args });
          return method(...args);
        };
      },
    },
  ) as WebGL2RenderingContext;

  return {
    gl,
    state,
    errors,
    calls,
    live: () => objects.filter((o) => !o.deleted),
    created,
    draws: () => draws,
    enumName,
  };
}
