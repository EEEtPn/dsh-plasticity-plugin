#!/usr/bin/env node
// Generate docs/TOOLS.md from the live tool definitions (single source of truth).
//
//   node --import ./test/setup-hooks.mjs scripts/gen-tools-docs.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as plugin from "../lib/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registered = [];
plugin.apply(
  {
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    effect(fn) { fn(); },
    get() { return undefined; },
  },
  { workDir: process.cwd() },
);

const typeOf = (parameter) => {
  if (parameter.enum) return `enum(${parameter.enum.join(" | ")})`;
  if (parameter.type === "array") return `array<${parameter.items?.type ?? "any"}>`;
  return parameter.type ?? "any";
};

const lines = [
  "# 工具参考（自动生成）",
  "",
  "> 本文件由 `scripts/gen-tools-docs.mjs` 从 `lib/index.js` 的工具定义生成，请勿手工编辑。",
  "> 全部参数在 DSH 侧使用 **mm / 度**；`id` 一律来自 `plasticity_scene`。",
  "",
  `共 ${registered.length} 个工具。`,
  "",
];

for (const tool of registered.sort((a, b) => a.name.localeCompare(b.name))) {
  lines.push(`## \`${tool.name}\``, "", tool.description.replace(/^\[[^\]]+\]\s*/, ""), "");
  const parameters = Object.entries(tool.parameters ?? {});
  if (parameters.length === 0) {
    lines.push("_无参数。_", "");
  } else {
    lines.push("| 参数 | 类型 | 必填 | 说明 |", "|---|---|---|---|");
    for (const [name, parameter] of parameters) {
      const required = parameter.required === true ? "是" : "";
      const description = String(parameter.description ?? "").replaceAll("|", "\\|");
      lines.push(`| \`${name}\` | ${typeOf(parameter)} | ${required} | ${description} |`);
    }
    lines.push("");
  }
  lines.push(`- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 ${tool.timeoutMs} ms。`, "");
}

fs.writeFileSync(path.join(root, "docs/TOOLS.md"), lines.join("\n"));
console.log(`docs/TOOLS.md written (${registered.length} tools)`);
