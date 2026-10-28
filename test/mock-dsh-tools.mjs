// Minimal stand-in for the host's @deepseek-ai/dsh-tools used by tests and tooling.
// `defineTool` in the real host validates/normalizes the definition; the tests only
// need the identity so they can inspect the specs the plugin registers.
export function defineTool(spec) {
  return spec;
}
