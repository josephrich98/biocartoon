//! The icon gallery is an optional MCP App; all catalog tools retain their text results.
use crate::mcp;
use serde_json::{json, Value};

pub const URI: &str = "ui://biocartoon/icon-gallery-v2.html";
const MIME: &str = "text/html;profile=mcp-app";

pub fn descriptor() -> Value {
    json!({"uri": URI, "name": "BioCartoon icon gallery", "description": "Compare illustrations, read their credits, and download PNG or SVG files.", "mimeType": MIME})
}

pub fn resource(uri: &str) -> Option<Value> {
    (uri == URI).then(|| json!({"contents": [{
        "uri": URI, "mimeType": MIME, "text": include_str!("../ui/dist/gallery.html"),
        "_meta": {"ui": {"prefersBorder": true, "permissions": {"clipboardWrite": {}}, "csp": {
            "connectDomains": [], "resourceDomains": ["https://assets.biocartoon.com"]
        }}}
    }]}))
}

pub fn render_tool() -> Value {
    let mut t = mcp::tool("render_assets", "Show illustration gallery", "Show selected icons in an interactive gallery with previews, licenses, credit lines and PNG/SVG downloads. First call search_assets and judge which results fit, then pass up to 12 selected IDs. Returns usable text and links in clients without app UI.", json!({
        "ids": {"type": "array", "items": {"type": "string", "minLength": 1}, "minItems": 1, "maxItems": 12, "uniqueItems": true, "description": "Selected asset IDs, in display order."}
    }), &["ids"]);
    t["_meta"] = json!({"ui": {"resourceUri": URI}, "openai/toolInvocation/invoking": "Loading illustrations…", "openai/toolInvocation/invoked": "Illustrations ready"});
    t
}

pub fn asset_ids(args: &Value) -> Result<Vec<&str>, String> {
    let ids = args["ids"].as_array().ok_or("ids must be an array of 1–12 asset IDs")?;
    if ids.is_empty() || ids.len() > 12 { return Err("choose 1–12 asset IDs".into()); }
    let mut seen = std::collections::HashSet::new();
    ids.iter().map(|id| {
        let id = id.as_str().filter(|s| !s.trim().is_empty()).ok_or("each asset ID must be a nonempty string")?;
        if !seen.insert(id) { return Err(format!("duplicate asset ID: {id}")); }
        Ok(id)
    }).collect()
}

/// Preserve the model-readable payload and expose the same authoritative records to the UI.
pub fn structured_result(name: &str, content: Vec<Value>) -> Value {
    let key = match name {
        "search_assets" | "browse_assets" | "asset_variants" | "render_assets" => "assets",
        "get_asset" => "asset",
        _ => return json!({"content": content, "isError": false}),
    };
    let data = content.iter().rev().find_map(|block| {
        block.get("text").and_then(Value::as_str).and_then(|s| serde_json::from_str::<Value>(s).ok())
    });
    if name == "render_assets" {
        if let Some(data) = data {
            // The gallery shows previews, credits and downloads; the model gets a note and a plain fallback list.
            return json!({"content": [mcp::text(GALLERY_NOTE), mcp::text(&gallery_text(&data))], "structuredContent": {key: data}, "isError": false});
        }
    }
    let mut result = json!({"content": content, "isError": false});
    if let Some(data) = data { result["structuredContent"] = json!({key: data}); }
    result
}

/// What the model reads after render_assets: the gallery is already on screen, so do not repeat it, and never add
/// pictures from elsewhere (they would not be these files). Kept in step with worker/src/mcp_catalog.ts.
pub const GALLERY_NOTE: &str = "The BioCartoon gallery is now showing the user these illustrations with their real previews, credit lines, licenses and PNG/SVG download buttons. Do not repeat the list and do not show any images yourself: pictures from image search or the web are not these files and would mislead the user. Reply in one or two sentences, e.g. which illustration you would pick and why, and any credit line it requires. Only if the user cannot see the gallery (a client without app UI), list the illustrations below by title with their credit and download links, without images.";

fn gallery_text(assets: &Value) -> String {
    let s = |a: &Value, k: &str| a[k].as_str().unwrap_or("").to_string();
    assets.as_array().into_iter().flatten().enumerate().map(|(i, a)| {
        let variant = s(a, "variant");
        let variant = if variant.is_empty() { String::new() } else { format!(" ({variant})") };
        let svg = a["svg_url"].as_str().map(|u| format!("SVG: {u}  ")).unwrap_or_default();
        format!("{}. {} · {}{} · {}\n   License: {}. Credit: {}\n   {}PNG: {}", i + 1, s(a, "id"), s(a, "title"), variant, s(a, "source"), s(a, "license"), s(a, "credit"), svg, s(a, "url"))
    }).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::{handle, CatalogTools, Chain, Tools};

    #[test]
    fn discovers_and_reads_gallery_through_chain() {
        let mut tools = Chain(vec![Box::new(CatalogTools::default())]);
        let info = mcp::catalog_server_info();
        let init = handle(&info, &mut tools, "initialize", &json!({})).unwrap();
        assert_eq!(init["capabilities"]["resources"]["subscribe"], false);
        let listed = handle(&info, &mut tools, "resources/list", &json!({})).unwrap();
        assert_eq!(listed["resources"][0]["uri"], URI);
        let read = handle(&info, &mut tools, "resources/read", &json!({"uri": URI})).unwrap();
        assert_eq!(read["contents"][0]["mimeType"], MIME);
        assert!(read["contents"][0]["text"].as_str().unwrap().contains("<!doctype html>"));
        assert_eq!(handle(&info, &mut tools, "resources/read", &json!({"uri": "ui://missing"})).unwrap_err().0, -32002);
        assert_eq!(handle(&info, &mut tools, "resources/read", &json!({})).unwrap_err().0, -32602);
        let ts = tools.tools();
        assert_eq!(ts.iter().find(|t| t["name"] == "render_assets").unwrap()["_meta"]["ui"]["resourceUri"], URI);
        assert!(ts.iter().find(|t| t["name"] == "search_assets").unwrap().get("_meta").is_none());
    }

    #[test]
    fn rejects_invalid_gallery_requests_before_opening_catalog() {
        for args in [json!({}), json!({"ids": []}), json!({"ids": [1]}), json!({"ids": [""]}), json!({"ids": ["BA1", "BA1"]}), json!({"ids": (0..13).map(|i| i.to_string()).collect::<Vec<_>>()})] {
            let mut tools = CatalogTools::default();
            assert!(tools.call_result("render_assets", &args).unwrap().is_err());
        }
        assert_eq!(asset_ids(&json!({"ids": ["BA2", "BA1"]})).unwrap(), ["BA2", "BA1"]);
    }

    #[test]
    fn structured_data_preserves_text_and_legacy_tools() {
        let content = vec![mcp::text("Candidates"), mcp::pretty(&json!([{"id": "BA1", "credit": "Author, CC BY"}]))];
        let r = structured_result("search_assets", content.clone());
        assert_eq!(r["content"], json!(content));
        assert_eq!(r["structuredContent"]["assets"][0]["id"], "BA1");
        assert!(structured_result("preview_assets", content).get("structuredContent").is_none());
    }
}
