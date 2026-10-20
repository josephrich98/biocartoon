//! An MCP server over stdio (`biocartoon mcp`), so an assistant such as Claude Code can
//! search the icon catalog and look at candidates. JSON-RPC 2.0, one message per line; only the
//! `tools` capability. Nothing but protocol messages may go to stdout, so logs go to stderr.
//!
//! The server is generic over a [`Tools`] set: [`CatalogTools`] is the catalog's, and a program
//! with tools of its own (the BioCartoon editor's canvas tools) wraps it and serves both.

use crate::catalog::IconSort;
use crate::query::{self, Asset, Catalog};
use crate::templates;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// What an assistant needs to know to use [`CatalogTools`] well.
pub const CATALOG_INSTRUCTIONS: &str = "The BioCartoon catalog is a library of about 20,000 open-licensed scientific illustrations \
(NIH BioArt, Bioicons, Servier Medical Art, SciDraw, Health Icons, Reactome, OpenMoji, plus user uploads).\n\
Search ALWAYS returns the closest matches, even when nothing in the library fits. Judge every result from its title, \
description, tags, category and matched_fields (a term found only in the description is a weak match; title or tags \
are strong). Look at the picture with asset_image when a title is ambiguous, and tell the user plainly when the library \
has nothing suitable instead of using a poor match. Prefer the science collections (bioart, bioicons, servier, scidraw) \
for biology; healthicons for clinical/public-health symbols; openmoji for generic emoji-style pictograms. Variants of one \
asset (asset_variants) are the same drawing in other colours. Every asset keeps its own license: credit it as its \
`credit` field says.\n\
list_templates finds shared slide templates (whole slide layouts, not icons); they open in the BioCartoon editor, so \
point the user to a template by its title rather than rebuilding it.";

/// A set of MCP tools.
pub trait Tools {
    /// The tool definitions (`tools/list`).
    fn tools(&self) -> Vec<Value>;
    /// Run tool `name`, returning its content blocks; `None` when it is not one of these tools.
    fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>>;
}

/// Who the server says it is in `initialize`.
pub struct ServerInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub instructions: String,
}

pub fn text(t: impl Into<String>) -> Value {
    json!({"type": "text", "text": t.into()})
}

pub fn pretty(v: &impl serde::Serialize) -> Value {
    text(serde_json::to_string_pretty(v).unwrap_or_default())
}

pub fn image_png(png: &[u8]) -> Value {
    json!({"type": "image", "data": base64::engine::general_purpose::STANDARD.encode(png), "mimeType": "image/png"})
}

pub fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": props, "required": required, "additionalProperties": false},
    })
}

pub fn str_prop(desc: &str) -> Value {
    json!({"type": "string", "description": desc})
}
pub fn num_prop(desc: &str) -> Value {
    json!({"type": "number", "description": desc})
}
pub fn int_prop(desc: &str) -> Value {
    json!({"type": "integer", "description": desc})
}
pub fn bool_prop(desc: &str) -> Value {
    json!({"type": "boolean", "description": desc})
}

/// What search results carry (the description shortened; use get_asset for all of it).
pub fn brief(a: &Asset) -> Value {
    let mut d: String = a.description.chars().take(300).collect();
    if d.len() < a.description.len() {
        d.push('…');
    }
    let mut v = json!({
        "id": a.id, "source": a.source, "title": a.title, "variant": a.variant, "category": a.category,
        "description": d, "tags": a.tags, "license": a.license, "credit": a.credit, "width": a.width, "height": a.height,
        "url": a.url, "stars": a.stars,
    });
    if !a.matched_fields.is_empty() {
        v["matched_fields"] = json!(a.matched_fields);
    }
    if !a.missing_terms.is_empty() {
        v["missing_terms"] = json!(a.missing_terms);
    }
    v
}

pub fn parse_sort(s: &str) -> IconSort {
    use IconSort::*;
    match s.to_lowercase().as_str() {
        "az" | "alphabetical" | "a-z" => Alphabetical,
        "za" | "reverse" | "z-a" => ReverseAlphabetical,
        "popular" | "popularity" => Popular,
        _ => Alphabetical,
    }
}

/// The catalog tools: search, look at and browse assets, plus read-only SQL. The catalog is
/// opened (and downloaded, the first time) on the first call that needs it.
#[derive(Default)]
pub struct CatalogTools {
    catalog: Option<Catalog>,
    /// The published template list, brought up to date on the first template call.
    templates: Option<std::path::PathBuf>,
}

impl CatalogTools {
    pub fn catalog(&mut self) -> Result<&Catalog, String> {
        if self.catalog.is_none() {
            self.catalog = Some(Catalog::open_default()?);
        }
        Ok(self.catalog.as_ref().unwrap())
    }

    fn templates(&mut self, query: &str) -> Result<Vec<templates::PublishedTemplate>, String> {
        if self.templates.is_none() {
            self.templates = Some(templates::ensure_templates()?);
        }
        templates::search(self.templates.as_ref().unwrap(), query)
    }
}

impl Tools for CatalogTools {
    fn tools(&self) -> Vec<Value> {
        let search_props = json!({
            "query": str_prop("Words to look for (prefix match over title, tags, category, description)."),
            "sources": {"type": "array", "items": {"type": "string"}, "description": "Restrict to these collections: bioart, bioicons, servier, scidraw, healthicons, reactome, openmoji, user. Default: all."},
            "limit": int_prop("Most results to return (default 12, max 60)."),
            "sort": str_prop("Order of the returned set: relevance (default), az, za, popular."),
        });
        vec![
            tool("search_assets", "Search the icon catalog. Returns the closest matches whether or not any truly fits: read each result's title, description, tags and matched_fields before using it (see the server instructions). Without a query, lists the most popular / first assets.", search_props, &[]),
            tool("get_asset", "Everything the catalog knows about one asset: description, tags, license, credit line, image URL and size.", json!({"id": str_prop("Asset id.")}), &["id"]),
            tool("asset_variants", "The same drawing in its other colour schemes / styles (same source and title).", json!({"id": str_prop("Asset id.")}), &["id"]),
            tool("asset_image", "Look at an asset: returns its PNG (downscaled) so you can check that it depicts what the user asked for.", json!({"id": str_prop("Asset id."), "max_side": int_prop("Longest side in pixels (default 512).")}), &["id"]),
            tool("browse_assets", "Page through a collection, optionally one category (see list_categories).", json!({"source": str_prop("Collection id."), "category": str_prop("Category name."), "offset": int_prop("Skip this many."), "limit": int_prop("Page size (default 40, max 200).")}), &["source"]),
            tool("list_sources", "The collections in the catalog with their sizes and licenses.", json!({}), &[]),
            tool("list_categories", "A collection's categories with counts.", json!({"source": str_prop("Collection id.")}), &["source"]),
            tool("sql_query", "Run one read-only SQL statement (SQLite) against the catalog, e.g. to count, group or search with your own conditions. See db_schema first. Rows are capped.", json!({"sql": str_prop("A SELECT / WITH statement."), "max_rows": int_prop("Row cap (default 100, max 1000).")}), &["sql"]),
            tool("db_schema", "The catalog's tables and indexes, with notes on full-text search.", json!({}), &[]),
            tool("list_templates", "Shared slide templates (whole slide layouts users published from the BioCartoon editor), newest first. Optional word filter.", json!({"query": str_prop("Words that must appear in the title, description or category.")}), &[]),
            tool("template_image", "The thumbnail of a shared template, to see its layout.", json!({"id": str_prop("Template id (from list_templates).")}), &["id"]),
        ]
    }

    fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
        const NAMES: [&str; 11] = [
            "search_assets", "get_asset", "asset_variants", "asset_image", "browse_assets", "list_sources", "list_categories", "sql_query", "db_schema",
            "list_templates", "template_image",
        ];
        NAMES.contains(&name).then(|| self.run(name, args))
    }
}

impl CatalogTools {
    fn run(&mut self, name: &str, args: &Value) -> Result<Vec<Value>, String> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
        let n = |k: &str| args.get(k).and_then(Value::as_u64);
        let need = |k: &str| s(k).ok_or_else(|| format!("{k} is required"));
        Ok(match name {
            "search_assets" => {
                let q = s("query").unwrap_or_default();
                let sources: Vec<String> = args.get("sources").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                let limit = n("limit").unwrap_or(12).clamp(1, 60) as usize;
                // "relevance" keeps the editor's pick order (science collections first, then rank).
                let sort = parse_sort(&s("sort").unwrap_or_default());
                let hits = self.catalog()?.search(&q, &sources, limit, sort)?;
                let note = if hits.is_empty() {
                    format!("No asset matches {q:?}. Try fewer or more general words, a synonym, or sql_query.")
                } else {
                    format!("{} result(s) for {q:?} (closest matches, not guaranteed to fit; judge each by title / tags / description).", hits.len())
                };
                vec![text(note), pretty(&hits.iter().map(brief).collect::<Vec<_>>())]
            }
            "get_asset" => {
                let id = need("id")?;
                match self.catalog()?.get(&id)? {
                    Some(a) => vec![pretty(&a)],
                    None => return Err(format!("no asset {id}")),
                }
            }
            "asset_variants" => {
                let id = need("id")?;
                let v = self.catalog()?.variants(&id)?;
                vec![pretty(&v.iter().map(brief).collect::<Vec<_>>())]
            }
            "asset_image" => {
                let id = need("id")?;
                let max = n("max_side").unwrap_or(512).clamp(32, 2048) as u32;
                let cat = self.catalog()?;
                let a = cat.get(&id)?.ok_or_else(|| format!("no asset {id}"))?;
                let (png, w, h) = query::shrink_png(&cat.fetch_png(&a)?, max)?;
                vec![text(format!("{} ({}, {}) — {}x{} px shown; original {}x{}. Credit: {}", a.title, a.source_name, a.license, w, h, a.width, a.height, a.credit)), image_png(&png)]
            }
            "browse_assets" => {
                let source = need("source")?;
                let limit = n("limit").unwrap_or(40).clamp(1, 200) as usize;
                let rows = self.catalog()?.browse(&source, s("category").as_deref(), n("offset").unwrap_or(0) as usize, limit, parse_sort(""))?;
                vec![pretty(&rows.iter().map(brief).collect::<Vec<_>>())]
            }
            "list_sources" => {
                let v: Vec<Value> = self.catalog()?.sources()?.iter().map(|s| json!({"source": s.source, "name": s.name, "count": s.count, "icons": s.icons, "licenses": s.licenses})).collect();
                vec![pretty(&v)]
            }
            "list_categories" => {
                let source = need("source")?;
                let v: Vec<Value> = self.catalog()?.categories(&source)?.iter().map(|c| json!({"name": c.name, "count": c.count})).collect();
                vec![pretty(&v)]
            }
            "sql_query" => {
                let sql = need("sql")?;
                let r = self.catalog()?.sql(&sql, n("max_rows").unwrap_or(100).clamp(1, 1000) as usize)?;
                let mut out = vec![pretty(&r)];
                if r.truncated {
                    out.insert(0, text("Row cap reached; the result is truncated."));
                }
                out
            }
            "db_schema" => vec![text(self.catalog()?.schema()?)],
            "list_templates" => {
                let q = s("query").unwrap_or_default();
                let hits = self.templates(&q)?;
                let note = if hits.is_empty() { format!("No shared template matches {q:?}.") } else { format!("{} template(s).", hits.len()) };
                vec![text(note), pretty(&hits)]
            }
            "template_image" => {
                let id = need("id")?;
                let t = self.templates("")?.into_iter().find(|t| t.id == id).ok_or_else(|| format!("no template {id}"))?;
                let url = t.thumb_url.ok_or("this template has no thumbnail")?;
                let (png, _, _) = query::shrink_png(&query::fetch_url(&url)?, 512)?;
                vec![text(format!("{} — {} ({}, by {})", t.title, t.description, t.license, t.author)), image_png(&png)]
            }
            other => return Err(format!("unknown tool {other}")),
        })
    }
}

/// Handle one request; `Err((code, message))` becomes a JSON-RPC error.
pub fn handle(info: &ServerInfo, tools: &mut dyn Tools, method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION);
            let version = if ["2024-11-05", "2025-03-26", "2025-06-18"].contains(&requested) { requested } else { PROTOCOL_VERSION };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": info.name, "version": info.version},
                "instructions": info.instructions,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools.tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).ok_or((-32602, "name is required".to_string()))?;
            let args = params.get("arguments").cloned().unwrap_or(Value::Object(Map::new()));
            let res = tools.call(name, &args).unwrap_or_else(|| Err(format!("unknown tool {name}")));
            Ok(match res {
                Ok(content) => json!({"content": content, "isError": false}),
                Err(e) => json!({"content": [text(e)], "isError": true}),
            })
        }
        "resources/list" => Ok(json!({"resources": []})),
        "prompts/list" => Ok(json!({"prompts": []})),
        other => Err((-32601, format!("method not found: {other}"))),
    }
}

/// Serve MCP on stdin/stdout until the client closes the pipe.
pub fn serve(info: &ServerInfo, tools: &mut dyn Tools) -> Result<(), String> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                write_msg(&stdout, &json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}}))?;
                continue;
            }
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
        let params = msg.get("params").cloned().unwrap_or(Value::Object(Map::new()));
        // Notifications (no id) get no reply.
        let Some(id) = id.filter(|i| !i.is_null()) else { continue };
        let reply = match handle(info, tools, &method, &params) {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
        };
        write_msg(&stdout, &reply)?;
    }
    Ok(())
}

/// Serve only the catalog tools (`biocartoon mcp` from this crate).
pub fn serve_catalog() -> Result<(), String> {
    let info = ServerInfo { name: "biocartoon-catalog", version: env!("CARGO_PKG_VERSION"), instructions: CATALOG_INSTRUCTIONS.into() };
    serve(&info, &mut CatalogTools::default())
}

fn write_msg(stdout: &std::io::Stdout, v: &Value) -> Result<(), String> {
    let mut out = stdout.lock();
    out.write_all(v.to_string().as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush()).map_err(|e| e.to_string())
}

/// Checks a tool list: unique names, object schemas, and every required field a property.
pub fn check_tool_schemas(ts: &[Value]) {
    let mut names = std::collections::HashSet::new();
    for t in ts {
        let name = t["name"].as_str().unwrap();
        assert!(names.insert(name.to_string()), "duplicate tool {name}");
        let schema = &t["inputSchema"];
        assert_eq!(schema["type"], "object");
        let props = schema["properties"].as_object().unwrap();
        for r in schema["required"].as_array().unwrap() {
            assert!(props.contains_key(r.as_str().unwrap()), "{name}: required {r} is not a property");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schemas_are_well_formed() {
        let ts = CatalogTools::default().tools();
        assert_eq!(ts.len(), 11);
        check_tool_schemas(&ts);
    }

    #[test]
    fn initialize_and_unknown_method() {
        let info = ServerInfo { name: "t", version: "0", instructions: CATALOG_INSTRUCTIONS.into() };
        let mut tools = CatalogTools::default();
        let r = handle(&info, &mut tools, "initialize", &json!({"protocolVersion": "2025-03-26"})).unwrap();
        assert_eq!(r["protocolVersion"], "2025-03-26");
        assert!(r["instructions"].as_str().unwrap().contains("asset_image"));
        assert_eq!(handle(&info, &mut tools, "initialize", &json!({"protocolVersion": "1999-01-01"})).unwrap()["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(handle(&info, &mut tools, "nope", &json!({})).unwrap_err().0, -32601);
        // An unknown tool is a tool error, not a protocol error.
        let r = handle(&info, &mut tools, "tools/call", &json!({"name": "canvas_state"})).unwrap();
        assert_eq!(r["isError"], true);
    }
}
