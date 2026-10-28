/**
 * dsh-plasticity-plugin — host side.
 *
 * Drives Plasticity 3D (CAD / NURBS / Parasolid kernel) from DSH tools through a
 * loopback Electron CDP bridge:
 *   1. launch Plasticity with --inspect-brk on the main process
 *   2. patch app.commandLine before app.ready so the renderer gets a DevTools port
 *   3. find the live Editor object in the renderer and run CAD commands through
 *      Plasticity's own command/Factory pipeline (native B-rep, real Undo history)
 *
 * Everything is millimetres (CAD convention) at the tool boundary; Plasticity's
 * internal unit is metres, so the page-side code converts.
 *
 * Tool surface mirrors dsh-cad's CAD ergonomics (scene / measure / create /
 * extrude / boolean / fillet / transform / export / screenshot) and ports the
 * practical operation set from the community plasticity-mcp project (MIT).
 */

import fs from "node:fs";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  DEFAULT_INSPECTOR_PORT,
  DEFAULT_RENDERER_PORT,
  cdpReachable,
  findPlasticityExe,
  killPlasticityTree,
  launchPlasticity,
  plasticityRunning,
} from "./protocol.js";
import { PlasticitySession } from "./session.js";
import { createOps } from "./ops.js";

export const name = "dsh-plasticity-plugin";

/** The host provides the tool registry. */
export const inject = ["tools"];

const PLUGIN_VERSION = "0.2.0";
// Mirrors dsh-blender-plugin: the host accepts the "json" schema keyword for free-form results.
const ANY_SCHEMA = { type: "json" };

// ---------------------------------------------------------------- sanitizing
/**
 * The host validates tool results with a strict JSON walker: undefined values,
 * NaN/Infinity and -0 all fail the whole channel. Normalize every result here.
 */
function sanitize(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value)) return null;
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (type === "string" || type === "boolean") return value;
  if (type === "bigint") return Number(value);
  if (type === "function" || type === "symbol") return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  if (seen.has(value)) return null;
  seen.add(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = sanitize(item, seen);
  }
  return out;
}

function renderResult(_args, value) {
  const blocks = [{ type: "text", text: String((value && value.text) || "") }];
  if (value && value.image) blocks.push({ type: "image", attachment: value.image });
  if (value && Array.isArray(value.images)) {
    for (const image of value.images) blocks.push({ type: "image", attachment: image });
  }
  return blocks;
}

function textResult(text) {
  return { text };
}

/** Session workspace (host cwd is the profile dir, not the workspace). */
function workspaceOf(exec, fallback) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined;
  return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : fallback;
}

// ---------------------------------------------------------------- bridge host
let bridge = null; // { session, ops, port }
let queue = Promise.resolve();

function serial(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function attach(rendererPort = DEFAULT_RENDERER_PORT) {
  if (bridge && bridge.session && !bridge.session.cdp.closed) return bridge;
  if (!(await cdpReachable(rendererPort))) {
    throw new Error(
      `Plasticity is not reachable on 127.0.0.1:${rendererPort}. ` +
        "Call plasticity_launch first (it starts Plasticity with the loopback debug port).",
    );
  }
  const session = await PlasticitySession.open({ rendererPort });
  const ops = createOps(session);
  const bootstrap = await session.ensureBootstrap();
  bridge = { session, ops, port: rendererPort, bootstrap, pid: bridge?.pid ?? null };
  return bridge;
}

function dropBridge() {
  try {
    bridge?.session?.close();
  } catch {
    /* ignore */
  }
  bridge = null;
}

function fmtNumber(value, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function summarizeScene(scene) {
  const bodies = scene?.bodies ?? [];
  const solids = bodies.filter((b) => b.type === "Solid" || b.type === "Sheet");
  const lines = [
    `Plasticity scene: ${bodies.length} node(s), ${solids.length} solid/sheet, undo ${scene?.undoDepth ?? 0} / redo ${scene?.redoDepth ?? 0}`,
  ];
  for (const body of bodies.slice(0, 40)) {
    const size = body.boundsMm
      ? `${fmtNumber(body.boundsMm.max[0] - body.boundsMm.min[0])}×${fmtNumber(body.boundsMm.max[1] - body.boundsMm.min[1])}×${fmtNumber(body.boundsMm.max[2] - body.boundsMm.min[2])} mm`
      : "no bbox";
    lines.push(`  #${body.id} ${body.type}${body.name ? ` "${body.name}"` : ""} — ${size}, ${body.faceIds?.length ?? 0} faces, ${body.edgeIds?.length ?? 0} edges`);
    if (Array.isArray(body.edges) && body.edges.length > 0) {
      const edges = body.edges.slice(0, 12).map((edge) => {
        const kind = edge.circle ? "circle" : edge.line ? "line" : "curve";
        return `${edge.id}(${kind}${typeof edge.lengthMm === "number" ? ` ${fmtNumber(edge.lengthMm, 1)}mm` : ""})`;
      });
      lines.push(`      edges: ${edges.join(" ")}${body.edges.length > 24 ? " …" : ""}`);
    }
    if (Array.isArray(body.faces) && body.faces.length > 0) {
      const faces = body.faces.slice(0, 10).map((face) => {
        const kind = face.planar ? "planar" : typeof face.radiusMm === "number" ? `cyl r${fmtNumber(face.radiusMm, 1)}` : "freeform";
        return `${face.id}(${kind})`;
      });
      lines.push(`      faces: ${faces.join(" ")}${body.faces.length > 16 ? " …" : ""}`);
    }
  }
  if (bodies.length > 40) lines.push(`  … ${bodies.length - 40} more`);
  return lines.join("\n");
}

async function ensureOps(rendererPort) {
  const host = await attach(rendererPort);
  return host;
}

/**
 * Plasticity restores its crash-recovery document asynchronously, so a freshly
 * launched instance briefly shows an empty/untitled document. Wait until the
 * document id and body id set are stable before letting tools mutate anything.
 */
async function waitForStableScene(host, { timeoutMs = 20_000, settleMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    const scene = await host.ops.scene({ includeTopology: false });
    const signature = `${scene.document}|${(scene.bodies || []).map((body) => body.id).join(",")}`;
    if (previous && previous.signature === signature) return scene;
    previous = { signature, scene };
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return previous?.scene ?? (await host.ops.scene({ includeTopology: false }));
}

// ---------------------------------------------------------------- tool factory
const tool = (spec) => {
  const withVersion = {
    ...spec,
    description: `[plasticity v${PLUGIN_VERSION}] ${String(spec.description || "")}`,
    output: { schema: ANY_SCHEMA, render: renderResult },
    execute: async (args, exec) => {
      const raw = await spec.execute(args ?? {}, exec);
      return sanitize(raw);
    },
  };
  return defineTool(withVersion);
};

export function apply(ctx, config = {}) {
  const state = {
    rendererPort: config.rendererPort ?? DEFAULT_RENDERER_PORT,
    inspectorPort: config.inspectorPort ?? DEFAULT_INSPECTOR_PORT,
    exe: config.exe ?? null,
    workDir: config.workDir ?? process.cwd(),
  };

  const saveImage = async (buffer, name, workspace = state.workDir) => {
    const dir = path.join(workspace, ".dsh-plasticity", "shots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, buffer);
    let attachment = null;
    try {
      const attachments = ctx.get("attachments");
      if (attachments && typeof attachments.saveImage === "function") {
        const ref = await attachments.saveImage({ data: buffer, mediaType: "image/png", name });
        attachment = ref;
      }
    } catch {
      attachment = null;
    }
    return { file, attachment };
  };

  const tools = [
    tool({
      name: "plasticity_status",
      description:
        "Report the Plasticity bridge state: whether Plasticity is running, whether the loopback CDP port is reachable, the live tool/command surface, and the current scene summary. Use it first; then plasticity_launch if not connected.",
      parameters: {},
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute() {
        const running = plasticityRunning();
        let exe = null;
        try { exe = state.exe ?? findPlasticityExe(); } catch { exe = null; }
        const reachable = await cdpReachable(state.rendererPort);
        if (!reachable) {
          return textResult(
            `Plasticity: ${running ? "running" : "not running"}; bridge: not connected (no CDP page on 127.0.0.1:${state.rendererPort}).\n` +
              `exe: ${exe ?? "not found"}\n` +
              `→ call plasticity_launch {isolated:true} to start a throw-away instance, or quit your own Plasticity and launch non-isolated to drive that one.`,
          );
        }
        const host = await serial(() => attach(state.rendererPort));
        const scene = await serial(() => host.ops.scene({ includeTopology: false }));
        return {
          text:
            `Plasticity bridge: CONNECTED on 127.0.0.1:${state.rendererPort}\n` +
            `exe: ${exe ?? "?"}\n` +
            `store: ${host.bootstrap?.storeShape ?? "?"}, commands: ${host.bootstrap?.commandCount ?? "?"}\n` +
            summarizeScene(scene),
          bootstrap: host.bootstrap,
          scene: { document: scene.document, undoDepth: scene.undoDepth, redoDepth: scene.redoDepth, bodies: scene.bodies },
        };
      },
    }),

    tool({
      name: "plasticity_launch",
      description:
        "Start Plasticity with a loopback DevTools port so the bridge can drive it. isolated=true starts a throw-away user-data directory (safe while your own window is open); isolated=false drives your normal session, which requires Plasticity to be closed first. Optionally killExisting=true closes running Plasticity instances first.",
      parameters: {
        isolated: { type: "boolean", description: "Use a throw-away user-data directory instead of your normal session (default false)." },
        killExisting: { type: "boolean", description: "Kill every running Plasticity.exe first (default false)." },
        rendererPort: { type: "integer", description: "Loopback DevTools port (default 9223)." },
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const isolated = args.isolated === true;
          if (args.killExisting) {
            killPlasticityTree(null, { allInstances: true });
            dropBridge();
            await new Promise((resolve) => setTimeout(resolve, 1500));
          } else if (!isolated && plasticityRunning()) {
            return textResult(
              "Plasticity is already running without the debug port. Save your work, quit Plasticity, then call plasticity_launch {isolated:false} again (or use killExisting:true).",
            );
          }
          const port = args.rendererPort ?? state.rendererPort;
          dropBridge();
          const launched = await launchPlasticity({
            exe: state.exe ?? undefined,
            isolated,
            rendererPort: port,
            inspectorPort: state.inspectorPort,
          });
          state.rendererPort = port;
          const host = await attach(port);
          bridge.pid = launched.pid;
          const settled = await waitForStableScene(host);
          return {
            text:
              `Plasticity launched (pid ${launched.pid}, ${isolated ? "isolated" : "live"} session).\n` +
              `bridge: 127.0.0.1:${port}; store ${host.bootstrap?.storeShape}, ${host.bootstrap?.commandCount} commands available.\n` +
              `document: ${settled?.document ?? "?"} (${settled?.bodies?.length ?? 0} node(s))\n` +
              (isolated
                ? "This window is throw-away: it runs with a private TEMP, so it does not overwrite your session's crash-recovery document." +
                  (launched.recoveryBackup ? ` Snapshot of the previous one: ${launched.recoveryBackup}` : "")
                : "Driving your live session — changes are real and land in Undo history."),
            pid: launched.pid,
            rendererPort: port,
            userDataDirectory: launched.userDataDirectory ?? null,
            recoveryBackup: launched.recoveryBackup ?? null,
            document: settled?.document ?? null,
            bodies: (settled?.bodies ?? []).map((body) => ({ id: body.id, type: body.type, name: body.name })),
            bootstrap: host.bootstrap,
          };
        });
      },
    }),

    tool({
      name: "plasticity_scene",
      description:
        "Read the current document: bodies with public ids, type, name, bbox (mm), face/edge ids, and per-face/per-edge geometry when includeTopology=true. Body ids returned here are the ids every other tool takes.",
      parameters: {
        includeTopology: { type: "boolean", description: "Include faces/edges detail (default true; set false for a compact listing)." },
        bodyLimit: { type: "integer", description: "Max bodies to return topology for (default 40)." },
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          const scene = await host.ops.scene({ includeTopology: args.includeTopology !== false });
          const limit = args.bodyLimit ?? 40;
          const bodies = (scene.bodies ?? []).slice(0, limit);
          return {
            text: summarizeScene(scene),
            document: scene.document,
            undoDepth: scene.undoDepth,
            redoDepth: scene.redoDepth,
            bodies,
            truncated: (scene.bodies?.length ?? 0) > limit,
          };
        });
      },
    }),

    tool({
      name: "plasticity_measure",
      description:
        "Measure native B-rep bodies: volume (mm³), surface area (mm²), bounding box, size and native validity codes. Omit ids to measure every solid/sheet in the document.",
      parameters: {
        ids: { type: "array", items: { type: "string" }, description: "Body ids from plasticity_scene; omit for all bodies." },
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          let ids = Array.isArray(args.ids) && args.ids.length > 0 ? args.ids.map(String) : null;
          if (!ids) {
            const scene = await host.ops.scene({ includeTopology: false });
            ids = (scene.bodies ?? []).filter((b) => b.type === "Solid" || b.type === "Sheet").map((b) => b.id);
          }
          if (ids.length === 0) return textResult("No solid bodies to measure.");
          const rows = await host.ops.measure(ids);
          const lines = rows.map((row) =>
            `#${row.id}${row.name ? ` "${row.name}"` : ""}: volume ${fmtNumber(row.volumeMm3, 1)} mm³, area ${fmtNumber(row.surfaceAreaMm2, 1)} mm², ` +
            `size ${(row.sizeMm ?? []).map((v) => fmtNumber(v, 2)).join("×")} mm` +
            (row.nativeCheckCodes?.length ? `, ⚠ native check ${row.nativeCheckCodes.join(",")}` : ", healthy"),
          );
          return { text: lines.join("\n"), measurements: rows };
        });
      },
    }),

    tool({
      name: "plasticity_create",
      description:
        "Create a native solid primitive in the active document: kind=box (originMm corner + sizeMm), cylinder (centerMm = base center, radiusMm, heightMm, optional axis), sphere (centerMm + radiusMm). All units mm; results are real Parasolid solids and land in Undo history.",
      parameters: {
        kind: { type: "string", required: true, enum: ["box", "cylinder", "sphere"], description: "Primitive kind." },
        originMm: { type: "array", items: { type: "number" }, description: "Box corner (mm) [x,y,z]." },
        sizeMm: { type: "array", items: { type: "number" }, description: "Box size (mm) [x,y,z]." },
        centerMm: { type: "array", items: { type: "number" }, description: "Cylinder base center / sphere center (mm)." },
        radiusMm: { type: "number", description: "Cylinder / sphere radius (mm)." },
        heightMm: { type: "number", description: "Cylinder height (mm)." },
        axis: { type: "array", items: { type: "number" }, description: "Cylinder axis (default [0,0,1])." },
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          // Validate the request before touching the bridge so bad arguments fail fast
          // (and never start/attach Plasticity just to reject a typo).
          if (args.kind === "box") {
            if (!Array.isArray(args.originMm) || !Array.isArray(args.sizeMm)) throw new Error("box requires originMm and sizeMm");
          } else if (args.kind === "cylinder") {
            if (!Array.isArray(args.centerMm) || typeof args.radiusMm !== "number" || typeof args.heightMm !== "number") {
              throw new Error("cylinder requires centerMm, radiusMm, heightMm");
            }
          } else if (args.kind === "sphere") {
            if (!Array.isArray(args.centerMm) || typeof args.radiusMm !== "number") throw new Error("sphere requires centerMm and radiusMm");
          } else {
            throw new Error(`unsupported kind: ${args.kind}`);
          }
          const host = await ensureOps(state.rendererPort);
          let result;
          if (args.kind === "box") {
            if (!Array.isArray(args.originMm) || !Array.isArray(args.sizeMm)) throw new Error("box requires originMm and sizeMm");
            result = await host.ops.createBox({ originMm: args.originMm, sizeMm: args.sizeMm });
          } else if (args.kind === "cylinder") {
            if (!Array.isArray(args.centerMm) || typeof args.radiusMm !== "number" || typeof args.heightMm !== "number") {
              throw new Error("cylinder requires centerMm, radiusMm, heightMm");
            }
            result = await host.ops.createCylinder({
              centerMm: args.centerMm, radiusMm: args.radiusMm, heightMm: args.heightMm,
              axis: Array.isArray(args.axis) ? args.axis : [0, 0, 1],
            });
          } else if (args.kind === "sphere") {
            if (!Array.isArray(args.centerMm) || typeof args.radiusMm !== "number") throw new Error("sphere requires centerMm and radiusMm");
            result = await host.ops.createSphere({ centerMm: args.centerMm, radiusMm: args.radiusMm });
          } else {
            throw new Error(`unsupported kind: ${args.kind}`);
          }
          const added = Array.isArray(result?.added) ? result.added : [];
          const created = result?.created ?? null;
          const createdText = added.length
            ? added.map((body) => `#${body.id} ${body.type}${body.name ? ` "${body.name}"` : ""}` +
                (body.boundsMm ? ` (${(body.boundsMm.max.map((v, i) => fmtNumber(v - body.boundsMm.min[i], 1))).join("×")} mm)` : "")).join(", ")
            : "created";
          return { text: `${args.kind} created: ${createdText}`, created, added };
        });
      },
    }),

    tool({
      name: "plasticity_extrude",
      description:
        "Extrude native geometry. Mode A: pass bodyId + faceIds (from plasticity_scene) to push/pull faces. Mode B: pass pointsMm (closed polygon, mm, on the XY plane at planeZMm) and the tool builds the polyline, reuses the native region and extrudes it into a solid. distanceMm may be negative.",
      parameters: {
        bodyId: { type: "string", description: "Body whose faces are extruded (mode A)." },
        faceIds: { type: "array", items: { type: "string" }, description: "Face ids to extrude (mode A)." },
        pointsMm: { type: "json", description: "Closed polygon [[x,y],...] in mm (mode B)." },
        planeZMm: { type: "number", description: "Z height of the sketch plane (mode B, default 0)." },
        distanceMm: { type: "number", required: true, description: "Extrude distance (mm); negative extrudes the other way." },
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          if (typeof args.distanceMm !== "number") throw new Error("distanceMm is required");
          if (Array.isArray(args.faceIds) && args.faceIds.length > 0) {
            const result = await host.ops.extrudeFaces({
              bodyId: String(args.bodyId), faceIds: args.faceIds.map(String), distanceMm: args.distanceMm,
            });
            return { text: `Extruded ${args.faceIds.length} face(s) by ${args.distanceMm} mm`, created: result?.created ?? null };
          }
          if (Array.isArray(args.pointsMm) && args.pointsMm.length >= 3) {
            const result = await host.ops.extrudeProfile({
              pointsMm: args.pointsMm, planeZMm: args.planeZMm ?? 0, distanceMm: args.distanceMm,
            });
            return { text: `Extruded profile by ${args.distanceMm} mm (${result?.regions ?? 1} region)`, created: result?.created ?? null };
          }
          throw new Error("provide faceIds+bodyId or pointsMm (>=3 points)");
        });
      },
    }),

    tool({
      name: "plasticity_boolean",
      description:
        "Boolean between native solids: operation=union|difference|intersection. targetIds are modified, toolIds are consumed unless keepTools=true. Returns the resulting bodies.",
      parameters: {
        operation: { type: "string", required: true, enum: ["union", "difference", "intersection"], description: "Boolean operation." },
        targetIds: { type: "array", items: { type: "string" }, required: true, description: "Target body ids." },
        toolIds: { type: "array", items: { type: "string" }, required: true, description: "Tool body ids." },
        keepTools: { type: "boolean", description: "Keep the tool bodies after the boolean (default false)." },
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          if (!Array.isArray(args.targetIds) || !Array.isArray(args.toolIds)) throw new Error("targetIds and toolIds are required");
          const result = await host.ops.boolean({
            operation: args.operation, targetIds: args.targetIds.map(String),
            toolIds: args.toolIds.map(String), keepTools: args.keepTools === true,
          });
          const created = Array.isArray(result?.created) ? result.created : result?.created ? [result.created] : [];
          return {
            text: `${args.operation}: ${created.length} result body(ies)` +
              (created.length ? ` — ${created.map((c) => `#${c.id ?? "?"} ${c.type}${c.name ? ` "${c.name}"` : ""}`).join(", ")}` : ""),
            created,
          };
        });
      },
    }),

    tool({
      name: "plasticity_fillet",
      description:
        "Round or chamfer native edges of one body: distanceMm > 0 with chamfer=false gives a fillet; chamfer=true gives a chamfer. edgeIds come from plasticity_scene; all edges must belong to bodyId.",
      parameters: {
        bodyId: { type: "string", required: true, description: "Body that owns the edges." },
        edgeIds: { type: "array", items: { type: "string" }, required: true, description: "Edge ids from plasticity_scene." },
        distanceMm: { type: "number", required: true, description: "Fillet radius / chamfer distance in mm." },
        chamfer: { type: "boolean", description: "true = chamfer, false (default) = fillet." },
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          if (typeof args.distanceMm !== "number") throw new Error("distanceMm is required");
          const result = await host.ops.fillet({
            bodyId: String(args.bodyId), edgeIds: (args.edgeIds ?? []).map(String),
            distanceMm: args.distanceMm, chamfer: args.chamfer === true,
          });
          return { text: `${args.chamfer ? "Chamfer" : "Fillet"} ${(args.edgeIds ?? []).length} edge(s) by ${args.distanceMm} mm`, created: result?.created ?? null };
        });
      },
    }),

    tool({
      name: "plasticity_transform",
      description:
        "Transform native bodies: translate (translateMm), rotate (rotateAxis + rotateDegrees + optional rotatePivotMm) and/or scale (scaleFactors + optional scalePivotMm). Each provided operation is applied as its own undoable command.",
      parameters: {
        ids: { type: "array", items: { type: "string" }, required: true, description: "Body ids to transform." },
        translateMm: { type: "array", items: { type: "number" }, description: "Translation delta (mm) [dx,dy,dz]." },
        rotateAxis: { type: "array", items: { type: "number" }, description: "Rotation axis (default [0,0,1])." },
        rotateDegrees: { type: "number", description: "Rotation angle in degrees." },
        rotatePivotMm: { type: "array", items: { type: "number" }, description: "Rotation pivot (mm, default origin)." },
        scaleFactors: { type: "array", items: { type: "number" }, description: "Scale factors [sx,sy,sz]." },
        scalePivotMm: { type: "array", items: { type: "number" }, description: "Scale pivot (mm, default origin)." },
      },
      timeoutMs: 240_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          const ids = (args.ids ?? []).map(String);
          if (ids.length === 0) throw new Error("ids is required");
          const done = [];
          if (Array.isArray(args.translateMm)) {
            await host.ops.move({ ids, deltaMm: args.translateMm });
            done.push(`translate ${args.translateMm.join(",")} mm`);
          }
          if (typeof args.rotateDegrees === "number") {
            await host.ops.rotate({
              ids, pivotMm: args.rotatePivotMm ?? [0, 0, 0],
              axis: args.rotateAxis ?? [0, 0, 1], degrees: args.rotateDegrees,
            });
            done.push(`rotate ${args.rotateDegrees}°`);
          }
          if (Array.isArray(args.scaleFactors)) {
            await host.ops.scale({ ids, pivotMm: args.scalePivotMm ?? [0, 0, 0], factors: args.scaleFactors });
            done.push(`scale ${args.scaleFactors.join(",")}`);
          }
          if (done.length === 0) throw new Error("provide translateMm, rotateDegrees or scaleFactors");
          return textResult(`Transformed ${ids.length} body(ies): ${done.join("; ")}`);
        });
      },
    }),

    tool({
      name: "plasticity_delete",
      description: "Delete native bodies by id (undoable).",
      parameters: {
        ids: { type: "array", items: { type: "string" }, required: true, description: "Body ids to delete." },
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          const ids = (args.ids ?? []).map(String);
          if (ids.length === 0) throw new Error("ids is required");
          const result = await host.ops.remove(ids);
          return textResult(`Deleted ${result?.removed ?? ids.length} body(ies)`);
        });
      },
    }),

    tool({
      name: "plasticity_history",
      description: "Undo or redo the last Plasticity command (direction=undo|redo).",
      parameters: {
        direction: { type: "string", required: true, enum: ["undo", "redo"], description: "History direction." },
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          if (args.direction === "redo") {
            const result = await host.ops.redo();
            return textResult(`Redo applied (redo stack ${result?.redoDepth ?? "?"})`);
          }
          const result = await host.ops.undo();
          return textResult(`Undo applied (undo stack ${result?.undoDepth ?? "?"})`);
        });
      },
    }),

    tool({
      name: "plasticity_export",
      description:
        "Export native geometry to disk next to the workspace: format=step (B-rep CAD interchange, .step/.stp), stl, 3mf or obj (mesh, tessellated with mm tolerances). Omit ids to export every solid/sheet. Returns the absolute output path and byte size.",
      parameters: {
        format: { type: "string", required: true, enum: ["step", "stl", "3mf", "obj"], description: "Export format." },
        path: { type: "string", description: "Output path (absolute or relative to the workspace). Default: .dsh-plasticity/exports/<timestamp>.<ext>." },
        ids: { type: "array", items: { type: "string" }, description: "Body ids; omit for all solids/sheets." },
        chordToleranceMm: { type: "number", description: "Mesh chord tolerance in mm (default 0.05)." },
        angleToleranceDegrees: { type: "number", description: "Mesh angle tolerance in degrees (default 5)." },
      },
      timeoutMs: 300_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          const workspace = workspaceOf(exec, state.workDir);
          const format = String(args.format).toLowerCase();
          let ids = Array.isArray(args.ids) && args.ids.length > 0 ? args.ids.map(String) : null;
          if (!ids) {
            const scene = await host.ops.scene({ includeTopology: false });
            ids = (scene.bodies ?? []).filter((b) => b.type === "Solid" || b.type === "Sheet").map((b) => b.id);
          }
          if (ids.length === 0) return textResult("No solid bodies to export.");
          const ext = format === "step" ? "step" : format;
          const target = args.path
            ? path.resolve(workspace, String(args.path))
            : path.join(workspace, ".dsh-plasticity", "exports", `part-${Date.now()}.${ext}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.rmSync(target, { force: true });
          await host.ops.exportCad({
            format, ids, path: target,
            chordToleranceMm: args.chordToleranceMm, angleToleranceDegrees: args.angleToleranceDegrees,
          });
          if (!fs.existsSync(target)) throw new Error(`Plasticity reported success but ${target} does not exist`);
          const bytes = fs.statSync(target).size;
          if (bytes === 0) throw new Error(`Export produced an empty file: ${target}`);
          return { text: `Exported ${ids.length} body(ies) → ${target} (${bytes} bytes)`, path: target, bytes, format, ids };
        });
      },
    }),

    tool({
      name: "plasticity_screenshot",
      description:
        "Capture the Plasticity viewport as a PNG. Saves it under .dsh-plasticity/shots/ and returns it as an image block when the host provides attachments. Use it to verify what the model looks like after a change.",
      parameters: {
        dismissDialogs: { type: "boolean", description: "Send Escape before capturing to close a half-open tool dialog (default true)." },
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          if (args.dismissDialogs !== false) {
            try { await host.session.escape(); } catch { /* not fatal */ }
          }
          const png = await host.session.screenshot();
          const { file, attachment } = await saveImage(png, `shot-${Date.now()}.png`, workspaceOf(exec, state.workDir));
          return {
            text: `Viewport captured (${png.length} bytes) → ${file}`,
            path: file,
            ...(attachment ? { image: attachment } : {}),
          };
        });
      },
    }),

    tool({
      name: "plasticity_view",
      description:
        "Aim the Plasticity viewport camera before a screenshot: preset direction (iso/front/back/left/right/top/bottom), explicit fromMm/targetMm, or an automatic distance framed on the current scene bounds. Returns the camera position/target in mm and the scene size.",
      parameters: {
        preset: { type: "string", enum: ["iso", "front", "back", "left", "right", "top", "bottom"], description: "Camera direction preset (default iso)." },
        fromMm: { type: "array", items: { type: "number" }, description: "Explicit camera position [x,y,z] in mm (overrides preset)." },
        targetMm: { type: "array", items: { type: "number" }, description: "Explicit look-at point [x,y,z] in mm (default: scene centre)." },
        distanceFactor: { type: "number", description: "Distance = scene max dimension × this factor (default 2.6)." },
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          const view = await host.ops.view({
            preset: args.preset, fromMm: args.fromMm, targetMm: args.targetMm, distanceFactor: args.distanceFactor,
          });
          return {
            text:
              `camera ${view?.preset ?? "custom"}: from [${(view?.positionMm ?? []).map((v) => fmtNumber(v, 1)).join(", ")}] mm` +
              ` → target [${(view?.targetMm ?? []).map((v) => fmtNumber(v, 1)).join(", ")}] mm` +
              `; scene size ${(view?.sceneSizeMm ?? []).map((v) => fmtNumber(v, 1)).join("×")} mm`,
            view,
          };
        });
      },
    }),

    tool({
      name: "plasticity_shutdown",
      description:
        "Close Plasticity and drop the bridge. Use allInstances=true only when you are sure no window of yours must stay open; the default kills the instance this bridge launched (by its window/pid) via taskkill and leaves the rest alone.",
      parameters: {
        allInstances: { type: "boolean", description: "Kill every Plasticity.exe instead of just the attached instance (default false)." },
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const all = args.allInstances === true;
          const pid = bridge?.pid ?? null;
          dropBridge();
          if (!all && !pid) {
            return textResult(
              "Bridge closed. This session was attached to an existing window (no pid recorded), so nothing was killed — close Plasticity yourself if you want it gone.",
            );
          }
          const killed = killPlasticityTree(pid, { allInstances: all });
          return textResult(
            killed
              ? `Plasticity ${all ? "(all instances)" : `(pid ${pid})`} terminated; bridge closed.`
              : "No Plasticity instance was running (bridge closed).",
          );
        });
      },
    }),

    tool({
      name: "plasticity_script",
      description:
        "Escape hatch: run JavaScript inside the Plasticity renderer with `editor` and the bridge prelude in scope (`editor`, `api`, `geo`, `db`, `find(id)`, `findItem(id)`, `mm/toM`, `Vector`/`Quaternion`/factory bindings are NOT provided automatically). Return a JSON-serializable value. Use it for operations this plugin does not wrap yet.",
      parameters: {
        code: { type: "string", required: true, description: "Async function body; `return` the value to report." },
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      async execute(args) {
        return await serial(async () => {
          const host = await ensureOps(state.rendererPort);
          const value = await host.ops.script(String(args.code ?? "return null;"));
          return { text: `script result: ${JSON.stringify(value)?.slice(0, 2000) ?? "null"}`, result: value };
        });
      },
    }),
  ];

  const disposers = tools.map((definition) => ctx.tools.register(definition));
  console.log(`[dsh-plasticity-plugin] v${PLUGIN_VERSION} registered ${String(tools.length)} tools`);
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
    dropBridge();
  });
}





