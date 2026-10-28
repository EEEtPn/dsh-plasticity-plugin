#!/usr/bin/env node
// Live smoke test against a locally installed Plasticity (Windows).
//
//   node scripts/verify-live.mjs              # launch an isolated instance, build a part, export, shut down
//   node scripts/verify-live.mjs --fuse-only  # only check Plasticity.exe has the Node-inspector fuse enabled
//
// Requires Plasticity 26.1.3 and a free inspector port (9229) / renderer port (9223).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchPlasticity, killPlasticityTree, findPlasticityExe } from "../lib/protocol.js";
import { PlasticitySession } from "../lib/session.js";
import { createOps } from "../lib/ops.js";

const fuseOnly = process.argv.includes("--fuse-only");
const exe = findPlasticityExe();
console.log("Plasticity:", exe);

if (fuseOnly) {
  console.log("fuse check:", checkFuse(exe) ? "EnableNodeCliInspectArguments = on" : "WARNING: inspector fuse not detected");
  process.exit(0);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plasticity-verify-"));
const launched = await launchPlasticity({ isolated: true });
let session;
const results = [];
try {
  session = await PlasticitySession.open({ rendererPort: launched.rendererPort });
  const ops = createOps(session);
  const boot = await ops.bootstrap();
  results.push(["bootstrap", boot.storeShape === "flat" || boot.storeShape === "versioned"]);

  const scene = await ops.scene({ includeTopology: true });
  results.push(["scene", Array.isArray(scene.bodies)]);

  const box = await ops.createBox({ originMm: [0, 0, 0], sizeMm: [40, 30, 20] });
  results.push(["createBox", (box.added?.length ?? 0) > 0]);

  const measure = await ops.measure([box.added[0].id]);
  results.push(["measure", Number(measure[0].volumeMm3) > 23000 && Number(measure[0].volumeMm3) < 25000]);

  const step = path.join(outDir, "verify.step");
  await ops.exportCad({ format: "step", ids: [box.added[0].id], path: step });
  results.push(["export STEP", fs.existsSync(step) && fs.readFileSync(step, "utf8").startsWith("ISO-10303-21;")]);

  const png = await session.screenshot();
  results.push(["screenshot", png.length > 10000]);

  const view = await ops.view({ preset: "iso" });
  results.push(["view", Array.isArray(view.positionMm)]);
} finally {
  try { session?.close(); } catch { /* ignore */ }
  killPlasticityTree(launched.pid);
  fs.rmSync(outDir, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
console.log(failed === 0 ? "\nverify-live: OK" : `\nverify-live: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

/** Scan the exe for the Electron fuse wire and read the EnableNodeCliInspectArguments byte. */
function checkFuse(executable) {
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
  const handle = fs.openSync(executable, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const chunk = 8 * 1024 * 1024;
    let carry = Buffer.alloc(0);
    for (let offset = 0; offset < size; offset += chunk) {
      const buffer = Buffer.alloc(Math.min(chunk, size - offset));
      fs.readSync(handle, buffer, 0, buffer.length, offset);
      const data = Buffer.concat([carry, buffer]);
      const index = data.indexOf(sentinel);
      if (index >= 0) {
        const wire = Buffer.alloc(2 + 16);
        fs.readSync(handle, wire, 0, wire.length, offset + index + sentinel.length);
        const version = wire[0];
        const count = wire[1];
        if (version !== 1 || count <= 3) return false;
        return wire[2 + 3] === 0x31;
      }
      carry = data.subarray(Math.max(0, data.length - sentinel.length));
    }
    return false;
  } finally {
    fs.closeSync(handle);
  }
}
