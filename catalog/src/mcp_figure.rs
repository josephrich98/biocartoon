//! Whole figures: `compose_figure`, `open_in_biocartoon` and `export_figure`. They run on the hosted
//! server (`worker/src/mcp_figure.ts`), which lays a figure out from the public catalog and keeps the
//! editor links; this server lists the same tools (`figure_tools.json`) and relays calls there, so
//! a local `biocartoon mcp` and the hosted endpoint offer the same figures.
use crate::mcp::Tools;
use serde_json::{json, Value};
use std::time::Duration;

const DEFS: &str = include_str!("figure_tools.json");
const HOSTED: &str = "https://mcp.biocartoon.com/mcp";

/// Where calls go: `BIOCARTOON_MCP_URL`, or the hosted server.
fn endpoint() -> String {
    std::env::var("BIOCARTOON_MCP_URL").ok().filter(|u| u.starts_with("https://") || u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost")).unwrap_or_else(|| HOSTED.into())
}

pub fn definitions() -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(DEFS).expect("figure_tools.json is a list of tools")
}

#[derive(Default)]
pub struct FigureTools;

impl FigureTools {
    fn relay(&self, name: &str, args: &Value) -> Result<Value, String> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}});
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(90))).http_status_as_error(false).build().into();
        let mut res = agent
            .post(&endpoint())
            .header("User-Agent", concat!("biocartoon-mcp/", env!("CARGO_PKG_VERSION")))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(body.to_string().as_bytes())
            .map_err(|e| format!("couldn't reach the BioCartoon figure server: {e}"))?;
        let status = res.status().as_u16();
        let bytes = res.body_mut().with_config().limit(16 << 20).read_to_vec().map_err(|e| format!("couldn't read the figure server's reply: {e}"))?;
        let reply: Value = serde_json::from_slice(&bytes).map_err(|e| format!("unexpected reply from the figure server (HTTP {status}): {e}"))?;
        if let Some(err) = reply.get("error") {
            return Err(err["message"].as_str().unwrap_or("the figure server refused the call").to_string());
        }
        let result = reply.get("result").cloned().ok_or("the figure server sent no result")?;
        if result["isError"] == json!(true) {
            let msg = result["content"].as_array().and_then(|c| c.iter().find_map(|b| b["text"].as_str())).unwrap_or("the figure server could not do that");
            return Err(msg.to_string());
        }
        Ok(result)
    }
}

impl Tools for FigureTools {
    fn tools(&self) -> Vec<Value> {
        definitions()
    }

    fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
        self.call_result(name, args).map(|r| r.map(|v| v["content"].as_array().cloned().unwrap_or_default()))
    }

    fn call_result(&mut self, name: &str, args: &Value) -> Option<Result<Value, String>> {
        definitions().iter().any(|t| t["name"] == name).then(|| self.relay(name, args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_are_valid_tools_with_the_gallery() {
        let defs = definitions();
        let names: Vec<&str> = defs.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(names, ["compose_figure", "open_in_biocartoon", "export_figure"]);
        for t in &defs {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(t["description"].as_str().unwrap().len() > 40);
        }
        assert_eq!(defs[0]["_meta"]["ui"]["resourceUri"], crate::mcp_ui::URI);
    }

    #[test]
    fn unknown_tools_pass_through() {
        assert!(FigureTools.call_result("search_assets", &json!({})).is_none());
    }
}
