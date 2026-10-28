// CDP transport + Plasticity launcher (Windows-first).
//
// Why this exists: Plasticity is an Electron app whose main process still honours
// --inspect-brk (EnableNodeCliInspectArguments fuse = on). We start it paused, patch
// app.commandLine before `app.ready` so the renderer gets a loopback DevTools port,
// then talk to the renderer over CDP. Nothing is patched on disk.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_INSPECTOR_PORT = 9229;
export const DEFAULT_RENDERER_PORT = 9223;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findPlasticityExe() {
  const override = process.env.PLASTICITY_EXE;
  if (override && fs.existsSync(override)) return override;
  const candidates = [];
  const local = process.env.LOCALAPPDATA;
  if (local) candidates.push(path.join(local, "Plasticity"));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "Plasticity"));
  candidates.push("C:\\Program Files\\Plasticity");
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    const versions = fs
      .readdirSync(root)
      .filter((name) => /^app-\d+(\.\d+)*$/.test(name) && fs.existsSync(path.join(root, name, "Plasticity.exe")))
      .sort((a, b) => compareVersions(b.slice(4), a.slice(4)));
    if (versions.length > 0) return path.join(root, versions[0], "Plasticity.exe");
  }
  throw new Error(
    "Plasticity.exe not found. Looked in %LOCALAPPDATA%\\Plasticity and Program Files. Set PLASTICITY_EXE to override.",
  );
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function plasticityRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Plasticity.exe", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return /Plasticity\.exe/i.test(out);
  } catch {
    return false;
  }
}

export async function waitFor(fn, timeoutMs, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

export class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  static async connect(wsUrl, timeoutMs = 15_000) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out opening CDP socket")), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP socket error")); }, { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.#ws = socket;
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("close", () => this.#onClose());
  }

  get closed() { return this.#closed; }

  on(method, listener) {
    const set = this.#listeners.get(method) ?? new Set();
    set.add(listener);
    this.#listeners.set(method, set);
    return () => set.delete(listener);
  }

  send(method, params, timeoutMs = 60_000) {
    if (this.#closed) return Promise.reject(new Error("CDP connection is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.#ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    });
  }

  close() {
    if (this.#closed) return;
    try { this.#ws.close(); } catch { /* ignore */ }
    this.#onClose();
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("CDP connection closed"));
    this.#pending.clear();
  }
}

const UNLOCK_EXPRESSION = (rendererPort) => `(() => {
  let electron;
  try { electron = process.mainModule?.require('electron'); } catch {}
  if (!electron?.app) { try { electron = require('electron'); } catch {} }
  if (!electron?.app) return { patched: false, reason: 'electron module unreachable' };
  const { app } = electron;
  if (app.isReady()) return { patched: false, tooLate: true };
  const commandLine = app.commandLine;
  const originalRemoveSwitch = commandLine.removeSwitch.bind(commandLine);
  commandLine.removeSwitch = (name) => {
    if (name === 'remote-debugging-port' || name === 'remote-debugging-pipe') return;
    return originalRemoveSwitch(name);
  };
  commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  commandLine.appendSwitch('remote-debugging-port', '${rendererPort}');
  return { patched: true, port: commandLine.getSwitchValue('remote-debugging-port') };
})()`;

/**
 * Start Plasticity with a loopback DevTools port on the renderer.
 * `isolated: true` uses a throw-away user-data directory, which sidesteps the
 * single-instance lock while the user keeps their own window open.
 */
export async function launchPlasticity(options = {}) {
  const exe = options.exe ?? findPlasticityExe();
  const inspectorPort = options.inspectorPort ?? DEFAULT_INSPECTOR_PORT;
  const rendererPort = options.rendererPort ?? DEFAULT_RENDERER_PORT;
  const args = [`--inspect-brk=127.0.0.1:${inspectorPort}`];
  let userDataDirectory = options.userDataDirectory;
  let privateTempDirectory = null;
  if (options.isolated) {
    userDataDirectory = path.join(os.tmpdir(), `dsh-plasticity-${Date.now()}`);
    // Plasticity writes its crash-recovery document to a FIXED path
    // (%TEMP%\plasticity\backup.production.plasticity) that --user-data-dir does NOT
    // cover. Point the child's TEMP at a private directory so an isolated instance
    // cannot overwrite the recovery document of the user's own session.
    privateTempDirectory = path.join(userDataDirectory, "tmp");
    fs.mkdirSync(privateTempDirectory, { recursive: true });
    args.push(`--user-data-dir=${userDataDirectory}`);
  } else if (userDataDirectory) {
    args.push(`--user-data-dir=${userDataDirectory}`);
  }

  const env = { ...process.env };
  // DSH's shell exports this; Electron would then run as plain Node (exit code 9).
  delete env.ELECTRON_RUN_AS_NODE;
  if (privateTempDirectory) {
    env.TEMP = privateTempDirectory;
    env.TMP = privateTempDirectory;
  }

  let recoveryBackup = null;
  if (options.isolated) {
    try { recoveryBackup = snapshotSharedRecovery(path.join(userDataDirectory, "recovery")); } catch { recoveryBackup = null; }
  }

  const child = spawn(exe, args, { detached: true, stdio: "ignore", env, windowsHide: false });
  child.unref();

  const inspector = await waitFor(async () => {
    const list = await fetchJson(`http://127.0.0.1:${inspectorPort}/json/list`);
    return list.find((target) => target.type === "node" && typeof target.webSocketDebuggerUrl === "string");
  }, options.inspectorTimeoutMs ?? 30_000);

  const inspectorClient = await Cdp.connect(inspector.webSocketDebuggerUrl);
  try {
    let receivePause;
    const paused = new Promise((resolve) => { receivePause = resolve; });
    inspectorClient.on("Debugger.paused", (params) => receivePause(params));
    await inspectorClient.send("Runtime.enable");
    await inspectorClient.send("Debugger.enable");
    await inspectorClient.send("Runtime.runIfWaitingForDebugger");
    const pause = await Promise.race([
      paused,
      sleep(15_000).then(() => { throw new Error("Plasticity main process never paused at startup"); }),
    ]);
    const callFrameId = pause?.callFrames?.[0]?.callFrameId;
    if (!callFrameId) throw new Error("Plasticity startup call frame unavailable");
    const patched = await inspectorClient.send("Debugger.evaluateOnCallFrame", {
      callFrameId,
      expression: UNLOCK_EXPRESSION(rendererPort),
      returnByValue: true,
    });
    const value = patched?.result?.value;
    if (value?.tooLate) throw new Error("Plasticity was already past startup; quit it and relaunch through the bridge");
    if (value?.patched !== true) throw new Error(`could not enable renderer CDP (${value?.reason ?? "unknown"})`);
    await inspectorClient.send("Debugger.resume");
  } finally {
    inspectorClient.close();
  }

  const page = await waitPageTarget(rendererPort, options.rendererTimeoutMs ?? 60_000);
  return { exe, pid: child.pid, userDataDirectory, privateTempDirectory, recoveryBackup, inspectorPort, rendererPort, page };
}

export async function fetchJson(url) {
  const response = await fetch(url, { redirect: "manual" });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

export async function listTargets(rendererPort = DEFAULT_RENDERER_PORT) {
  return fetchJson(`http://127.0.0.1:${rendererPort}/json/list`);
}

export async function waitPageTarget(rendererPort = DEFAULT_RENDERER_PORT, timeoutMs = 60_000) {
  return waitFor(async () => {
    const targets = await listTargets(rendererPort);
    return targets.find(
      (target) => target.type === "page" && String(target.url).includes("/renderer/app_window/index.html"),
    );
  }, timeoutMs, 250);
}

export async function cdpReachable(rendererPort = DEFAULT_RENDERER_PORT) {
  try {
    const targets = await listTargets(rendererPort);
    return targets.some((target) => target.type === "page" && String(target.url).includes("/renderer/app_window/index.html"));
  } catch {
    return false;
  }
}

/** Path of the shared crash-recovery document (NOT isolated by --user-data-dir). */
export function sharedRecoveryPath() {
  return path.join(os.tmpdir(), "plasticity", "backup.production.plasticity");
}

/**
 * Copy the shared crash-recovery document aside before an isolated launch.
 * Plasticity restores whatever is in there on every start, so a snapshot lets the
 * user put their own unsaved-document recovery back if an experiment clobbers it.
 * Returns the snapshot path (or null when there is nothing to snapshot).
 */
export function snapshotSharedRecovery(targetDirectory) {
  const source = sharedRecoveryPath();
  if (!fs.existsSync(source)) return null;
  fs.mkdirSync(targetDirectory, { recursive: true });
  const target = path.join(targetDirectory, `recovery-backup-${Date.now()}.plasticity`);
  fs.copyFileSync(source, target);
  return target;
}

export function killPlasticityTree(pid, { allInstances = false } = {}) {
  try {
    if (allInstances) execFileSync("taskkill", ["/IM", "Plasticity.exe", "/T", "/F"], { windowsHide: true });
    else execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

