// Test-only module hook: map the host package @deepseek-ai/dsh-tools to a local mock
// so lib/index.js can be imported outside DSH.
//
// Usage: node --import ./test/setup-hooks.mjs --test test/
import { registerHooks } from "node:module";

const mockUrl = new URL("./mock-dsh-tools.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@deepseek-ai/dsh-tools") {
      return { url: mockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
