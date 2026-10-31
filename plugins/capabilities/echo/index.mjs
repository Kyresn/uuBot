/**
 * Reference capability plugin (documented example).
 *
 * Runs in a worker thread; `api` is an RPC proxy and every core capability
 * call is gated by the permissions declared in manifest.json, except log and
 * reply, which are always allowed. The host calls `selfTest()` during
 * activation and exposes `tools.echo` to the agent.
 */
export function createPlugin(api) {
  api.log('echo capability: loaded');

  return {
    selfTest: async () => true,
    tools: {
      echo: async (args) => ({ echoed: args?.text ?? null }),
    },
  };
}
