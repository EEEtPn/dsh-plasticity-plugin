// Mock-host smoke checks: no Plasticity and no DSH required.
//
// These cover the failure mode that matters most (load-time registration) plus the
// schema shape defineTool expects and the one tool that must answer without a bridge.
// Run with the test hook that maps @deepseek-ai/dsh-tools to the local mock:
//
//   node --import ./test/setup-hooks.mjs ./test/smoke.mjs
import assert from "node:assert/strict";
import * as plugin from "../lib/index.js";

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push([name, true]);
  } catch (error) {
    results.push([name, `${error.message}`]);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    results.push([name, true]);
  } catch (error) {
    results.push([name, `${error.message}`]);
  }
};

const EXPECTED_TOOLS = [
  "plasticity_boolean", "plasticity_create", "plasticity_delete", "plasticity_export",
  "plasticity_extrude", "plasticity_fillet", "plasticity_history", "plasticity_launch",
  "plasticity_measure", "plasticity_scene", "plasticity_screenshot", "plasticity_script",
  "plasticity_shutdown", "plasticity_status", "plasticity_transform", "plasticity_view",
];

function loadPlugin() {
  const registered = [];
  plugin.apply(
    {
      tools: { register: (definition) => { registered.push(definition); return () => {}; } },
      effect: (fn) => fn(),
      get: () => undefined,
    },
    // Port 1 is never a live CDP endpoint: tools must fail fast instead of attaching.
    { workDir: process.cwd(), rendererPort: 1 },
  );
  return registered;
}

check("exports the DSH bundle contract", () => {
  assert.equal(plugin.name, "dsh-plasticity-plugin");
  assert.deepEqual(plugin.inject, ["tools"]);
  assert.equal(typeof plugin.apply, "function");
});

const registered = loadPlugin();
check("registers all 16 tools", () => {
  assert.deepEqual(registered.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
});

check("every tool definition is host-shaped", () => {
  for (const tool of registered) {
    assert.equal(typeof tool.name, "string");
    assert.match(tool.description, /plasticity v/, `${tool.name} description`);
    assert.equal(typeof tool.parameters, "object", `${tool.name} parameters`);
    assert.equal(typeof tool.execute, "function", `${tool.name} execute`);
    assert.equal(typeof tool.timeoutMs, "number", `${tool.name} timeoutMs`);
    assert.equal(typeof tool.isConcurrencySafe, "function", `${tool.name} isConcurrencySafe`);
    assert.deepEqual(tool.output.schema, { type: "json" }, `${tool.name} output schema`);
    const text = tool.output.render({}, { text: "hello" });
    assert.deepEqual(text, [{ type: "text", text: "hello" }], `${tool.name} text render`);
    const image = tool.output.render({}, { text: "img", image: { attachmentId: "a", mediaType: "image/png" } });
    assert.equal(image[1].type, "image", `${tool.name} image render`);
  }
});

await checkAsync("status answers without a bridge (port 1)", async () => {
  const status = registered.find((tool) => tool.name === "plasticity_status");
  const value = await status.execute({}, {});
  assert.match(value.text, /Plasticity/);
  assert.match(value.text, /plasticity_launch/);
});

await checkAsync("create validates parameters before touching Plasticity", async () => {
  const create = registered.find((tool) => tool.name === "plasticity_create");
  await assert.rejects(() => create.execute({ kind: "torus" }, {}), /unsupported kind/);
  await assert.rejects(() => create.execute({ kind: "box" }, {}), /originMm/);
  await assert.rejects(() => create.execute({ kind: "cylinder", centerMm: [0, 0, 0] }, {}), /radiusMm/);
});

await checkAsync("bridge-backed tools fail with an actionable message", async () => {
  const scene = registered.find((tool) => tool.name === "plasticity_scene");
  await assert.rejects(() => scene.execute({}, {}), /not reachable/);
  const script = registered.find((tool) => tool.name === "plasticity_script");
  await assert.rejects(() => script.execute({ code: "return 1;" }, {}), /not reachable/);
});

let failed = 0;
for (const [name, outcome] of results) {
  if (outcome === true) console.log(`PASS  ${name}`);
  else { failed += 1; console.log(`FAIL  ${name}\n      ${outcome}`); }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
