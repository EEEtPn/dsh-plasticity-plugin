#!/usr/bin/env node
// Pack the plugin into an npm-compatible tarball (package/ directory layout).
//
// Why a tarball: on this platform a `link:` install makes pnpm create a Windows
// junction that is later rejected as an "untrusted mount point", while a tarball is
// unpacked into a real directory. The tarball is also what plugin_manager installs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = manifest.version;

const outIndex = process.argv.indexOf("--out");
const outDir = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : process.cwd();
const target = path.join(outDir, `${manifest.name}-${version}.tgz`);

// npm "files" semantics is overkill here; mirror it explicitly for a predictable tarball.
const INCLUDED = ["package.json", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE", "icon.svg", "lib", "locale", "docs", "examples"];

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-plasticity-pack-"));
const pkgDir = path.join(stage, "package");
fs.mkdirSync(pkgDir, { recursive: true });

try {
  for (const item of INCLUDED) {
    const from = path.join(root, item);
    if (!fs.existsSync(from)) {
      console.warn(`warn: missing ${item}, skipped`);
      continue;
    }
    fs.cpSync(from, path.join(pkgDir, item), { recursive: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(target, { force: true });

  const tar = spawnSync("tar", ["-czf", target, "-C", stage, "package"], { stdio: "inherit" });
  if (tar.error) throw new Error(`tar not available: ${tar.error.message}. Install bsdtar (Windows 10+ ships it) or use npm pack.`);
  if (tar.status !== 0) throw new Error(`tar exited with ${tar.status}`);

  const size = fs.statSync(target).size;
  const files = countFiles(pkgDir);
  console.log(`packed: ${target} (${(size / 1024).toFixed(1)} KiB, ${files} files)`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}
