// Free-plan MCP App: the plugin keeps its skills, hosted tools and interactive gallery.
import gallery from "../../catalog/ui/dist/gallery.html";
import { createMcpHandler } from "./mcp_server.ts";
export default createMcpHandler(gallery);
