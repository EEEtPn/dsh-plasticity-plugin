// Renderer-side session: locate Plasticity's live Editor object, resolve command
// factories by name, and execute CAD operations through Plasticity's own command
// pipeline (edits land in Undo history exactly like UI actions).

import { Cdp, DEFAULT_RENDERER_PORT, waitPageTarget } from "./protocol.js";

const EDITOR_PROTO_FN = `function () {
  const matches = this.filter((fn) => fn.name === 'Editor' && fn.prototype &&
    ['open', 'save', 'exec'].every((key) => typeof fn.prototype[key] === 'function'));
  if (matches.length !== 1) throw new Error('Plasticity Editor prototype is missing or ambiguous: ' + matches.length);
  return matches[0].prototype;
}`;

// This build keeps a flat store (editor.geo.geometryModel); some builds wrap it in a
// versioned read layer (editor.geo.read.geometryModel). Accept both.
const EDITOR_STORE_FN = `function () {
  const matches = this.filter((editor) =>
    (editor.geo?.geometryModel || editor.geo?.read?.geometryModel) &&
    editor.nodes && editor.groups && editor.empties);
  if (matches.length !== 1) throw new Error('Plasticity store editor is missing or ambiguous: ' + matches.length);
  return matches[0];
}`;

const CAMERA_VECTOR_FN = `function () {
  const camera = Array.from(this.viewports)[0]?.camera;
  if (!camera?.position) throw new Error('Plasticity viewport camera is unavailable');
  return camera.position.constructor;
}`;

const CAMERA_QUATERNION_FN = `function () {
  const camera = Array.from(this.viewports)[0]?.camera;
  if (!camera?.quaternion) throw new Error('Plasticity camera quaternion is unavailable');
  return camera.quaternion.constructor;
}`;

const BOOTSTRAP_FN = `function () {
  const geo = this.geo;
  const geoModel = geo.geometryModel || (geo.read && geo.read.geometryModel);
  if (!geoModel) throw new Error('Plasticity geometryModel is unavailable');
  const nodes = this.nodes || (this.db && this.db.nodes);
  const pick = (name) => {
    if (typeof geo[name] === 'function') return geo[name].bind(geo);
    if (this.db && typeof this.db[name] === 'function') return this.db[name].bind(this.db);
    return undefined;
  };
  const nativeApi = {
    geo: {
      geometryModel: geoModel,
      get automatics() { return geo.automatics || (geo.read && geo.read.automatics); },
      get primaryPartition() { return geo.primaryPartition; },
    },
    db: {
      nodes,
      lookupStableId: pick('lookupStableId'),
      lookupTopologyItem: pick('lookupTopologyItem'),
      lookupBodyCollection: pick('lookupBodyCollection'),
      lookupFaceCollection: pick('lookupFaceCollection'),
    },
    selection: this.selection && this.selection.selected,
  };
  window.__plasticity = { editor: this, nativeApi };
  return {
    ok: true,
    storeShape: geo.geometryModel ? 'flat' : 'versioned',
    hasNodes: !!nodes,
    hasLookupStableId: typeof nativeApi.db.lookupStableId === 'function',
    hasBodyCollection: typeof nativeApi.db.lookupBodyCollection === 'function',
    hasSelection: !!nativeApi.selection,
    commandCount: Object.keys(this.commands || {}).length,
  };
}`;

// Shared page-side helpers injected in front of every operation body.
export const PRELUDE = `
  const editor = this;
  const api = window.__plasticity && window.__plasticity.nativeApi;
  if (!api) throw new Error('PLASTICITY_BOOTSTRAP_MISSING');
  const geo = api.geo, db = api.db;
  if (typeof db.lookupStableId !== 'function') throw new Error('Plasticity store lookup is unavailable');
  const sameId = (left, right) => String(left) === String(right);
  const find = (id) => {
    for (const [versionId, item] of geo.geometryModel) {
      if (sameId(db.lookupStableId(versionId), id)) return item.view;
    }
    throw new Error('Unknown body id: ' + id);
  };
  const findItem = (id) => {
    for (const [versionId, item] of geo.geometryModel) {
      if (sameId(db.lookupStableId(versionId), id)) return { versionId, item };
    }
    throw new Error('Unknown body id: ' + id);
  };
  const nameOf = (view) => {
    try {
      const key = db.nodes && db.nodes.item2key ? db.nodes.item2key(view) : undefined;
      if (key === undefined) return null;
      return db.nodes && typeof db.nodes.getName === 'function' ? (db.nodes.getName(key) ?? null) : null;
    } catch { return null; }
  };
  const describe = (value) => {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(describe);
    const out = { type: String((value.constructor && value.constructor.name) || typeof value) };
    for (const [versionId, item] of geo.geometryModel) {
      if (item.view === value) {
        const stableId = db.lookupStableId(versionId);
        if (stableId !== undefined && stableId !== null) out.id = stableId;
        break;
      }
    }
    const name = nameOf(value);
    if (name !== null) out.name = name;
    return out;
  };
  const mm = (value) => value * 1000;
  const toM = (value) => value / 1000;
  const vecMm = (v) => [mm(v.x), mm(v.y), mm(v.z)];
  const dir = (v) => [v.x, v.y, v.z];
`;

const objectIdOf = (result, what) => {
  if (result?.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`${what} failed: ${description}`);
  }
  const id = result?.result?.objectId ?? result?.objects?.objectId;
  if (!id) throw new Error(`${what} returned no object`);
  return id;
};

export class PlasticitySession {
  #resolved = new Map();
  #bootstrapped = false;

  constructor(cdp, page, rendererPort) {
    this.cdp = cdp;
    this.page = page;
    this.rendererPort = rendererPort;
    this.editorId = null;
    this.functionsId = null;
  }

  static async open(options = {}) {
    const rendererPort = options.rendererPort ?? Number(process.env.PLASTICITY_CDP_PORT ?? DEFAULT_RENDERER_PORT);
    const page = await waitPageTarget(rendererPort, options.timeoutMs ?? 15_000);
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    const session = new PlasticitySession(cdp, page, rendererPort);
    await session.#discoverWithRetry(options.discoverTimeoutMs ?? 120_000);
    return session;
  }

  async #discoverWithRetry(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await this.#discover();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw new Error(`Plasticity editor did not become reachable: ${lastError?.message ?? "unknown"}`);
  }

  async #discover() {
    const functionPrototype = objectIdOf(
      await this.cdp.send("Runtime.evaluate", { expression: "Function.prototype" }),
      "Function.prototype",
    );
    this.functionsId = objectIdOf(
      await this.cdp.send("Runtime.queryObjects", { prototypeObjectId: functionPrototype }),
      "queryObjects(Function)",
    );
    const editorPrototype = objectIdOf(
      await this.cdp.send("Runtime.callFunctionOn", {
        objectId: this.functionsId,
        functionDeclaration: EDITOR_PROTO_FN,
      }),
      "Editor prototype",
    );
    const editors = objectIdOf(
      await this.cdp.send("Runtime.queryObjects", { prototypeObjectId: editorPrototype }),
      "queryObjects(Editor)",
    );
    this.editorId = objectIdOf(
      await this.cdp.send("Runtime.callFunctionOn", {
        objectId: editors,
        functionDeclaration: EDITOR_STORE_FN,
      }),
      "store editor",
    );
    this.#resolved.clear();
    this.#bootstrapped = false;
  }

  async ensureBootstrap() {
    if (this.#bootstrapped) return undefined;
    const result = await this.cdp.send("Runtime.callFunctionOn", {
      objectId: this.editorId,
      functionDeclaration: BOOTSTRAP_FN,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Plasticity bootstrap failed: ${description}`);
    }
    this.#bootstrapped = true;
    return result?.result?.value;
  }

  async #invoke(functionDeclaration, callArgs, options = {}) {
    const result = await this.cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: this.editorId,
        functionDeclaration,
        arguments: callArgs,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      options.timeoutMs ?? 180_000,
    );
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Plasticity call failed: ${description}`);
    }
    return result?.result?.value;
  }

  /** Resolve the first available class from a candidate-name list. */
  async resolveFunctionAny(names) {
    for (const name of names) {
      const cached = this.#resolved.get(name);
      if (cached) return cached;
      const result = await this.cdp.send("Runtime.callFunctionOn", {
        objectId: this.functionsId,
        functionDeclaration: `function (name) {
          const exact = this.filter((fn) => fn?.name === name);
          if (exact.length === 0) return null;
          if (exact.length === 1) return exact[0];
          const scored = exact
            .map((fn) => ({ fn, size: fn.prototype ? Object.getOwnPropertyNames(fn.prototype).length : -1 }))
            .sort((a, b) => b.size - a.size);
          return scored[0].fn;
        }`,
        arguments: [{ value: name }],
      });
      const id = result?.result?.objectId ?? null;
      if (id) {
        this.#resolved.set(name, id);
        return id;
      }
    }
    throw new Error(`Plasticity class not found (tried: ${names.join(", ")})`);
  }

  async resolveVector() {
    const cached = this.#resolved.get("__vector");
    if (cached) return cached;
    const id = objectIdOf(
      await this.cdp.send("Runtime.callFunctionOn", {
        objectId: this.editorId,
        functionDeclaration: CAMERA_VECTOR_FN,
      }),
      "Vector3 class",
    );
    this.#resolved.set("__vector", id);
    return id;
  }

  async resolveQuaternion() {
    const cached = this.#resolved.get("__quaternion");
    if (cached) return cached;
    const id = objectIdOf(
      await this.cdp.send("Runtime.callFunctionOn", {
        objectId: this.editorId,
        functionDeclaration: CAMERA_QUATERNION_FN,
      }),
      "Quaternion class",
    );
    this.#resolved.set("__quaternion", id);
    return id;
  }

  /**
   * Run page-side code with the bridge prelude in scope.
   * bindings: [{ param, names }] — each resolved to a constructor and passed by objectId.
   */
  async runNative({ factory, factories, body, values = [], needVector = false, needQuaternion = false, timeoutMs }) {
    const bindingSpecs = factories ?? (factory ? [{ param: "Factory", names: factory }] : []);
    const run = async () => {
      await this.ensureBootstrap();
      const callArgs = [];
      const params = [];
      for (const spec of bindingSpecs) {
        callArgs.push({ objectId: await this.resolveFunctionAny(spec.names) });
        params.push(spec.param);
      }
      if (needVector) {
        callArgs.push({ objectId: await this.resolveVector() });
        params.push("Vector");
      }
      if (needQuaternion) {
        callArgs.push({ objectId: await this.resolveQuaternion() });
        params.push("Quaternion");
      }
      const argsValue = Array.isArray(values) ? (values.length === 1 ? values[0] : values) : values;
      callArgs.push({ value: argsValue });
      params.push("args");
      const declaration = `async function (${params.join(", ")}) {${PRELUDE}\n${body}\n}`;
      return await this.#invoke(declaration, callArgs, { timeoutMs });
    };
    return await this.#withBootstrapRetry(run);
  }

  /** Run page-side code with prelude; `arg` becomes the single `args` value. */
  async runRaw(body, arg = {}, options = {}) {
    const run = async () => {
      await this.ensureBootstrap();
      const declaration = `async function (args) {${PRELUDE}\n${body}\n}`;
      return await this.#invoke(declaration, [{ value: arg ?? {} }], options);
    };
    return await this.#withBootstrapRetry(run);
  }

  async #withBootstrapRetry(run) {
    try {
      return await run();
    } catch (error) {
      if (!String(error.message).includes("PLASTICITY_BOOTSTRAP_MISSING")) throw error;
      this.#bootstrapped = false;
      return await run();
    }
  }

  async onEditor(functionDeclaration, values = [], options = {}) {
    const result = await this.cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: this.editorId,
        functionDeclaration,
        arguments: values.map((value) => ({ value })),
        returnByValue: options.returnByValue ?? true,
        awaitPromise: options.awaitPromise ?? true,
      },
      options.timeoutMs ?? 120_000,
    );
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Plasticity call failed: ${description}`);
    }
    return result?.result?.value;
  }

  /** Send Escape to the renderer (dismisses a half-open Plasticity tool dialog). */
  async escape() {
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  async screenshot(options = {}) {
    const result = await this.cdp.send(
      "Page.captureScreenshot",
      { format: options.format ?? "png", fromSurface: true },
      options.timeoutMs ?? 30_000,
    );
    if (!result?.data) throw new Error("Plasticity returned no screenshot data");
    return Buffer.from(result.data, "base64");
  }

  close() {
    this.cdp.close();
  }
}



