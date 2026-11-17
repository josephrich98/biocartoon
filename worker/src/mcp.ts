// biocartoon-mcp: the hosted MCP server at mcp.biocartoon.com, for assistants that reach only remote
// servers (ChatGPT, claude.ai, Claude's mobile apps). The server itself is the `biocartoon` binary
// (`biocartoon mcp --http`, catalog/src/mcp_http.rs) in a Cloudflare Container built from
// catalog/Dockerfile; this Worker only passes requests to it. Its submissions go to api.biocartoon.com
// with the MCP_TOKEN secret, so its users share their own daily allowance (src/submit.ts).
//
// Deploy: npm run deploy:mcp (needs Docker running, and the Workers Paid plan for Containers).
// Secret: npx wrangler secret put MCP_TOKEN -c wrangler.mcp.jsonc, the same value as on biocartoon-submit.

import { Container, getRandom } from "@cloudflare/containers";

interface McpEnv {
  MCP_SERVER: DurableObjectNamespace<McpServer>;
  MCP_TOKEN?: string;
}

/** Containers sharing the traffic. Each serves 4 requests at once; most calls take milliseconds. */
const INSTANCES = 2;

export class McpServer extends Container<McpEnv> {
  defaultPort = 8080;
  // A sleeping container wakes in a few seconds on the next request and downloads the catalog again.
  sleepAfter = "30m";

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: McpEnv) {
    super(ctx, env);
    this.envVars = { PORT: "8080", BIOCARTOON_MCP_TOKEN: env.MCP_TOKEN ?? "" };
  }
}

export default {
  async fetch(req: Request, env: McpEnv): Promise<Response> {
    const stub = await getRandom(env.MCP_SERVER, INSTANCES);
    return stub.fetch(req);
  },
} satisfies ExportedHandler<McpEnv>;
