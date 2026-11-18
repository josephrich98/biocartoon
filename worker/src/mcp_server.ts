import metadata from "../generated/mcp-metadata.json" with { type: "json" };
import { catalogTool, text, type Args, type ToolResult } from "./mcp_catalog.ts";
import { artworkTool, type McpEnv } from "./mcp_artwork.ts";
import { sha256Hex } from "./http.ts";

const URI = metadata.resources[0].uri;
const MIME = "text/html;profile=mcp-app";
const ARTWORK_TOOLS = new Set(["asset_image", "asset_svg", "preview_assets", "template_image", "submit_artwork", "submission_status"]);
const TOOL_NAMES = new Set(metadata.tools.map(t => t.name));
const CACHE_TOOLS = new Set(["search_assets", "get_asset", "asset_variants", "browse_assets", "list_sources", "list_categories", "list_templates", "render_assets"]);
const MAX_BODY = 3 * 1024 * 1024;
const headers = {
  "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id",
  "Access-Control-Max-Age": "86400", "X-Content-Type-Options": "nosniff",
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function toolCall(env: McpEnv, name: string, args: Args, request: Request, ctx?: ExecutionContext): Promise<ToolResult> {
  const run = () => ARTWORK_TOOLS.has(name) ? artworkTool(env, name, args, request) : catalogTool(env.CATALOG, name, args);
  // Cache public catalog results only; never artwork, contacts, status or submissions.
  if (!CACHE_TOOLS.has(name) || typeof caches === "undefined") return run();
  const key = new Request(`https://mcp.biocartoon.com/cache/${metadata.serverInfo.version}/${await sha256Hex(JSON.stringify([name, args]))}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json() as Promise<ToolResult>;
  const result = await run();
  const put = caches.default.put(key, new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Cache-Control": "public,max-age=300" } }));
  if (ctx) ctx.waitUntil(put); else await put;
  return result;
}

export async function rpc(message: unknown, env: McpEnv, request: Request, gallery: string, ctx?: ExecutionContext): Promise<unknown | undefined> {
  if (!message || typeof message !== "object" || Array.isArray(message)) return rpcError(null, -32600, "Invalid Request");
  const m = message as Record<string, unknown>;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string" || ("id" in m && m.id !== null && typeof m.id !== "string" && typeof m.id !== "number")) return rpcError(null, -32600, "Invalid Request");
  if (!("id" in m)) return; // Notifications never receive a reply or execute tool calls.
  if (m.params !== undefined && (!m.params || typeof m.params !== "object" || Array.isArray(m.params))) return rpcError(m.id, -32602, "params must be an object");
  const p = (m.params ?? {}) as Args;
  let result: unknown;
  switch (m.method) {
    case "initialize": result = {
      protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(String(p.protocolVersion)) ? p.protocolVersion : "2025-06-18",
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
      serverInfo: metadata.serverInfo, instructions: metadata.instructions + "\nThe free hosted endpoint accepts PNG/SVG artwork without resizing. Use the local CLI to convert or resize other formats.",
    }; break;
    case "ping": result = {}; break;
    case "tools/list": result = { tools: metadata.tools }; break;
    case "resources/list": result = { resources: metadata.resources }; break;
    case "resources/templates/list": result = { resourceTemplates: [] }; break;
    case "prompts/list": result = { prompts: [] }; break;
    case "resources/read":
      if (typeof p.uri !== "string") return rpcError(m.id, -32602, "uri is required");
      if (p.uri !== URI) return rpcError(m.id, -32002, `resource not found: ${p.uri}`);
      result = { contents: [{ uri: URI, mimeType: MIME, text: gallery, _meta: { ui: { prefersBorder: true, permissions: { clipboardWrite: {} }, csp: { connectDomains: [], resourceDomains: ["https://assets.biocartoon.com"] } } } }] }; break;
    case "tools/call": {
      if (typeof p.name !== "string") return rpcError(m.id, -32602, "name is required");
      if (p.arguments !== undefined && (!p.arguments || typeof p.arguments !== "object" || Array.isArray(p.arguments))) return rpcError(m.id, -32602, "arguments must be an object");
      try {
        if (!TOOL_NAMES.has(p.name)) throw new Error(`unknown tool ${p.name}`);
        result = await toolCall(env, p.name, (p.arguments ?? {}) as Args, request, ctx);
      } catch (e) {
        // Never log arguments: they may contain artwork or contributor contact details.
        const error = e instanceof Error ? e.message : "Tool failed; please try again";
        const unavailable = /D1_ERROR|SQLITE_ERROR|database|quota|limit exceeded|CPU time/i.test(error);
        result = { content: [text(unavailable ? "The catalog is temporarily unavailable or its free quota has been reached. Please try again later." : error)], isError: true };
      }
      break;
    }
    default: return rpcError(m.id, -32601, `method not found: ${m.method}`);
  }
  return { jsonrpc: "2.0", id: m.id, result };
}

async function readBody(request: Request): Promise<string> {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY) throw new Error("Request exceeds 3 MB");
  const reader = request.body?.getReader(); if (!reader) return "";
  const decoder = new TextDecoder(); let size = 0, body = "";
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BODY) { await reader.cancel(); throw new Error("Request exceeds 3 MB"); } body += decoder.decode(value, { stream: true }); }
  } finally { reader.releaseLock(); }
  return body + decoder.decode();
}

export function createMcpHandler(gallery: string): ExportedHandler<McpEnv> {
  return {
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (path === "/health" && request.method === "GET") return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
      if (path === "/" && request.method === "GET") return new Response("BioCartoon MCP App\nConnect to https://mcp.biocartoon.com/mcp (Streamable HTTP, no sign-in).\n", { headers: { "Content-Type": "text/plain" } });
      if (!["/", "/mcp"].includes(path)) return json({ error: "Not found" }, 404);
      if (request.method !== "POST") return new Response(JSON.stringify({ error: "POST JSON-RPC requests; no event stream" }), { status: 405, headers: { ...headers, Allow: "POST, OPTIONS" } });
      let body: string;
      try { body = await readBody(request); } catch { return json({ error: "Request exceeds 3 MB" }, 413); }
      let message: unknown;
      try { message = JSON.parse(body); } catch { return json(rpcError(null, -32700, "Parse error"), 400); }
      if (Array.isArray(message)) {
        if (!message.length || message.length > 16) return json(rpcError(null, -32600, "A batch must contain 1–16 messages"), 400);
        const replies: unknown[] = [];
        for (const m of message) { const reply = await rpc(m, env, request, gallery, ctx); if (reply !== undefined) replies.push(reply); }
        return replies.length ? json(replies) : new Response(null, { status: 202, headers });
      }
      const reply = await rpc(message, env, request, gallery, ctx);
      return reply === undefined ? new Response(null, { status: 202, headers }) : json(reply);
    },
  };
}
