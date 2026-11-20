//! An MCP server over stdio (`biocartoon mcp`), so an assistant such as Claude Code can
//! search the icon catalog and look at candidates. JSON-RPC 2.0, one message per line, with
//! tools and optional MCP App resources. Nothing but protocol messages may go to stdout, so logs go to stderr.
//!
//! The server is generic over a [`Tools`] set: [`CatalogTools`] is the catalog's, and a program
//! with tools of its own (the BioCartoon editor's canvas tools) wraps it and serves both.

use crate::catalog::{Filter, IconSort};
use crate::query::{self, Asset, Catalog};
use crate::templates;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// What an assistant needs to know to use [`CatalogTools`] well.
pub const CATALOG_INSTRUCTIONS: &str = "The BioCartoon catalog is a library of about 20,000 open-licensed scientific illustrations \
(NIH BioArt, Bioicons, Servier Medical Art, SciDraw, Health Icons, Reactome, OpenMoji, Noto Emoji, plus user uploads).\n\
Account-management boundary: BioCartoon's tools cannot sign anyone in, see private saved projects, or delete \
projects or accounts. When asked to, answer directly without calling any tool: say the plugin can't do this, and that \
the user can delete a project from its menu on the home screen of https://app.biocartoon.com/, or delete their \
account and all its projects with \"Delete account\" in the account menu (top right of that screen). Do not open a \
browser, use computer control, run shell commands, or query the catalog to try it, even when those tools are \
available, and never claim that a project was accessed or deleted.\n\n\
Search ALWAYS returns the closest matches, even when nothing in the library fits. Judge every result from its title, \
description, tags, category and matched_fields (a term found only in the description is a weak match; title or tags \
are strong). Look at the picture with asset_image when a title is ambiguous, and tell the user plainly when the library \
has nothing suitable instead of using a poor match. Prefer the science collections (bioart, bioicons, servier, scidraw) \
for biology; healthicons for clinical/public-health symbols; openmoji and noto for generic emoji-style pictograms. Variants of one \
asset (asset_variants) are the same drawing in other colours. Every asset keeps its own license: credit it as its \
`credit` field says.\n\
After judging search results, use render_assets with the selected IDs to show an interactive gallery with previews, \
licenses, credits and download links. It also returns text for clients without UI support.\n\
list_templates finds shared slide templates (whole slide layouts, not icons); they open in the BioCartoon editor, so \
point the user to a template by its title rather than rebuilding it.\n\
Whole figures (a process, pathway, experiment or comparison): plan the elements (each a depictable thing, with a \
1-3 word query) and the arrows between them, and call compose_figure. It picks catalog icons, lays them out with \
labels and arrows, shows the figure in the gallery and returns an editor link (open_in_biocartoon makes one for any \
figure, icon or template). Judge its match report as you would search results; for changes, pass figure.spec back \
edited. Gaps stay as labelled boxes: say so rather than hiding them. Not for data charts.";

/// A set of MCP tools.
pub trait Tools {
    /// The tool definitions (`tools/list`).
    fn tools(&self) -> Vec<Value>;
    /// Run tool `name`, returning its content blocks; `None` when it is not one of these tools.
    fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>>;
    /// A full tool result, optionally including structured content for an MCP App.
    fn call_result(&mut self, name: &str, args: &Value) -> Option<Result<Value, String>> {
        self.call(name, args).map(|r| r.map(|content| json!({"content": content, "isError": false})))
    }
    fn resources(&self) -> Vec<Value> { vec![] }
    fn resource(&self, _uri: &str) -> Option<Value> { None }
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

/// Marks a tool as only reading (ChatGPT and Claude run these without asking each time).
pub fn read_only(mut t: Value) -> Value {
    t["annotations"] = json!({"title": t["title"], "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false});
    t
}

/// `title` is the human-readable name clients show (Claude's directory requires one per tool).
pub fn tool(name: &str, title: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "title": title,
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
    if let Some(t) = &a.thumb_url {
        v["thumb_url"] = json!(t);
    }
    if let Some(t) = &a.svg_url {
        v["svg_url"] = json!(t);
    }
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
    /// For a long-running server (`biocartoon mcp --http`): how often to look for a newer
    /// catalog file, and when it last looked. `None` keeps the first catalog opened.
    reload_every: Option<std::time::Duration>,
    checked: Option<std::time::Instant>,
}

impl CatalogTools {
    /// Catalog tools that switch to a newer downloaded catalog (and template list) at most
    /// `every` after the last look, for a server that outlives one catalog publish.
    pub fn reloading(every: std::time::Duration) -> Self {
        Self { reload_every: Some(every), ..Self::default() }
    }

    pub fn catalog(&mut self) -> Result<&Catalog, String> {
        if let (Some(every), Some(c)) = (self.reload_every, &self.catalog) {
            if self.checked.is_none_or(|t| t.elapsed() >= every) {
                self.checked = Some(std::time::Instant::now());
                if query::catalog_path().is_some_and(|p| p != c.path) {
                    self.catalog = None;
                    self.templates = None;
                }
            }
        }
        if self.catalog.is_none() {
            self.catalog = Some(Catalog::open_default()?);
            self.checked = Some(std::time::Instant::now());
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
            "sources": {"type": "array", "items": {"type": "string"}, "description": "Restrict to these collections: bioart, bioicons, servier, scidraw, healthicons, reactome, openmoji, noto, user. Default: all."},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "Keep only assets with one of these tags (a whole tag, any case). Default: any."},
            "limit": int_prop("Most results to return (default 12, max 60)."),
            "sort": str_prop("Order of the returned set: relevance (default), az, za, popular."),
            "licenses": {"type": "array", "items": {"type": "string"}, "description": "Keep only these licenses as stored (PD, CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0, ...). Default: any."},
            "author": str_prop("Part of the author's name; commas for several (any of them). Default: any."),
            "category": str_prop("A collection's own category (see list_categories); use with sources. Default: any."),
            "file_type": {"type": "string", "enum": ["svg", "png"], "description": "svg: only icons with an SVG (vector) version; png: only PNG-only icons. Default: either."},
        });
        vec![
            tool("search_assets", "Search illustrations", "Search the icon catalog. Returns the closest matches whether or not any truly fits: read each result's title, description, tags and matched_fields before using it (see the server instructions). Without a query, lists the most popular / first assets.", search_props, &[]),
            tool("get_asset", "Get illustration details", "Everything the catalog knows about one asset: description, tags, license, credit line, image URL and size.", json!({"id": str_prop("Asset id.")}), &["id"]),
            tool("asset_variants", "Find colour variants", "The same drawing in its other colour schemes / styles (same source and title).", json!({"id": str_prop("Asset id.")}), &["id"]),
            tool("asset_image", "View illustration", "Look at an asset: returns its PNG (downscaled) so you can check that it depicts what the user asked for.", json!({"id": str_prop("Asset id."), "max_side": int_prop("Longest side in pixels (default 512).")}), &["id"]),
            tool("asset_svg", "Get illustration SVG", "An asset's SVG markup, to adapt it (\"like this icon but ...\"): edit the markup rather than redrawing from scratch. Also says whether an adaptation may be submitted to the library under the asset's license. Servier and some uploads have no SVG; very detailed drawings are too large to edit as code (redraw from asset_image instead).", json!({"id": str_prop("Asset id."), "max_kb": int_prop("Largest markup to return, in kilobytes (default 150, max 500).")}), &["id"]),
            tool("preview_assets", "Preview illustrations", "Small previews (at most 256 px) of up to 12 assets at once, each labelled with its id, title, collection and license: for showing the user candidates side by side, or judging several search results in one call.", json!({"ids": {"type": "array", "items": {"type": "string"}, "description": "Asset ids, in the order to show them (at most 12)."}}), &["ids"]),
            crate::mcp_ui::render_tool(),
            tool("browse_assets", "Browse a collection", "Page through a collection, optionally one category (see list_categories).", json!({"source": str_prop("Collection id."), "category": str_prop("Category name."), "offset": int_prop("Skip this many."), "limit": int_prop("Page size (default 40, max 200).")}), &["source"]),
            tool("list_sources", "List collections", "The collections in the catalog with their sizes and licenses.", json!({}), &[]),
            tool("list_categories", "List categories", "A collection's categories with counts.", json!({"source": str_prop("Collection id.")}), &["source"]),
            tool("sql_query", "Query the catalog", "Run one read-only SQL statement (SQLite) against the catalog, e.g. to count, group or search with your own conditions. See db_schema first. Rows are capped.", json!({"sql": str_prop("A SELECT / WITH statement."), "max_rows": int_prop("Row cap (default 100, max 1000).")}), &["sql"]),
            tool("db_schema", "Describe catalog database", "The catalog's tables and indexes, with notes on full-text search.", json!({}), &[]),
            tool("list_templates", "List slide templates", "Shared slide templates (whole slide layouts users published from the BioCartoon editor), newest first. Optional word filter.", json!({"query": str_prop("Words that must appear in the title, description or category.")}), &[]),
            tool("template_image", "View slide template", "The thumbnail of a shared template, to see its layout.", json!({"id": str_prop("Template id (from list_templates).")}), &["id"]),
        ]
        .into_iter()
        .map(read_only)
        .collect()
    }

    fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
        const NAMES: [&str; 14] = [
            "search_assets", "get_asset", "asset_variants", "asset_image", "asset_svg", "preview_assets", "browse_assets", "list_sources", "list_categories", "sql_query", "db_schema",
            "list_templates", "template_image", "render_assets",
        ];
        NAMES.contains(&name).then(|| self.run(name, args))
    }

    fn call_result(&mut self, name: &str, args: &Value) -> Option<Result<Value, String>> {
        self.call(name, args).map(|r| r.map(|content| crate::mcp_ui::structured_result(name, content)))
    }

    fn resources(&self) -> Vec<Value> { vec![crate::mcp_ui::descriptor()] }
    fn resource(&self, uri: &str) -> Option<Value> { crate::mcp_ui::resource(uri) }
}

impl CatalogTools {
    fn run(&mut self, name: &str, args: &Value) -> Result<Vec<Value>, String> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
        let n = |k: &str| args.get(k).and_then(Value::as_u64);
        let need = |k: &str| s(k).ok_or_else(|| format!("{k} is required"));
        Ok(match name {
            "render_assets" => {
                let ids = crate::mcp_ui::asset_ids(args)?;
                let catalog = self.catalog()?;
                let hits: Vec<Value> = ids.iter().map(|id| {
                    catalog.get(id)?.map(|a| brief(&a)).ok_or_else(|| format!("no asset {id}"))
                }).collect::<Result<_, String>>()?;
                vec![text("Selected BioCartoon illustrations. Each download keeps its original license; use the supplied credit line."), pretty(&hits)]
            }
            "search_assets" => {
                let q = s("query").unwrap_or_default();
                let sources: Vec<String> = args.get("sources").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                let limit = n("limit").unwrap_or(12).clamp(1, 60) as usize;
                // "relevance" keeps the editor's pick order (science collections first, then rank).
                let sort = parse_sort(&s("sort").unwrap_or_default());
                let list = |k: &str| -> Vec<String> { args.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default() };
                let tags = list("tags");
                let licenses = list("licenses");
                let authors: Vec<String> = s("author").unwrap_or_default().split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();
                let formats: Vec<String> = match s("file_type").as_deref() {
                    None | Some("") => vec![],
                    Some("svg") => vec![crate::catalog::FORMAT_SVG.to_string()],
                    Some("png") => vec![crate::catalog::FORMAT_PNG.to_string()],
                    Some(_) => return Err("file_type must be svg or png".into()),
                };
                // A category belongs to a collection: the chosen ones, or any of them.
                let db_cats: Vec<(String, String)> = match s("category").filter(|c| !c.is_empty()) {
                    Some(c) => {
                        let dbs: Vec<String> = if sources.is_empty() { ["biocartoon", "user", "bioart", "bioicons", "servier", "scidraw", "healthicons", "reactome", "openmoji", "noto"].map(String::from).to_vec() } else { sources.clone() };
                        dbs.into_iter().map(|d| (d, c.clone())).collect()
                    }
                    None => vec![],
                };
                let hits = if tags.is_empty() && licenses.is_empty() && authors.is_empty() && formats.is_empty() && db_cats.is_empty() {
                    self.catalog()?.search(&q, &sources, limit, sort)?
                } else {
                    let filter = Filter { tags, licenses, authors, formats, db_cats, ..Filter::sources(&sources) };
                    self.catalog()?.search_filtered(&q, &filter, 0, limit, sort)?.0
                };
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
            "asset_svg" => {
                let id = need("id")?;
                let max = n("max_kb").unwrap_or(150).clamp(1, 500) as usize * 1024;
                let cat = self.catalog()?;
                let a = cat.get(&id)?.ok_or_else(|| format!("no asset {id}"))?;
                let raw = cat.fetch_svg(&a)?;
                let svg = slim_svg(&String::from_utf8_lossy(&raw));
                if svg.len() > max {
                    return Err(format!(
                        "{id}'s SVG is {} KB, more than {} KB: too detailed to edit as code. Look at it with asset_image and draw a simpler \
                         version in its style instead, or pass a larger max_kb (up to 500).",
                        svg.len() / 1024,
                        max / 1024
                    ));
                }
                vec![
                    text(format!(
                        "{} — {} ({}). Credit: {}\n{}\nKeep its style (outline weight, palette, level of detail) and change only what the user asked for.",
                        a.id,
                        a.title,
                        a.source_name,
                        a.credit,
                        crate::mcp_submit::adaptation_note(&a.license)
                    )),
                    text(svg),
                ]
            }
            "preview_assets" => {
                let ids: Vec<String> = args.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                if ids.is_empty() {
                    return Err("ids is required: one or more asset ids".into());
                }
                if ids.len() > 12 {
                    return Err(format!("at most 12 ids at once ({} given)", ids.len()));
                }
                let cat = self.catalog()?;
                let mut out = Vec::new();
                for (i, id) in ids.iter().enumerate() {
                    let Some(a) = cat.get(id)? else {
                        out.push(text(format!("{}. {id}: no such asset", i + 1)));
                        continue;
                    };
                    let png = match &a.thumb_url {
                        Some(u) => query::fetch_url(u).and_then(|b| query::shrink_png(&b, 256)),
                        None => cat.fetch_png(&a).and_then(|b| query::shrink_png(&b, 256)),
                    };
                    out.push(text(format!("{}. {} — {} ({}, {})", i + 1, a.id, a.title, a.source_name, a.license)));
                    match png {
                        Ok((png, _, _)) => out.push(image_png(&png)),
                        Err(e) => out.push(text(format!("   (no preview: {e})"))),
                    }
                }
                out
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

/// SVG markup without what only an editor needs: comments, `<metadata>` and Inkscape's
/// `<sodipodi:namedview>`, so less of it has to be read.
pub fn slim_svg(svg: &str) -> String {
    let mut s = svg.to_string();
    for (open, close) in [("<!--", "-->"), ("<metadata", "</metadata>"), ("<sodipodi:namedview", "</sodipodi:namedview>")] {
        while let Some(i) = s.find(open) {
            // An empty element (`<metadata/>`) ends at its own `/>`.
            let tag_end = s[i..].find('>').map(|j| i + j);
            let end = match tag_end {
                Some(t) if open != "<!--" && s[..t].ends_with('/') => t + 1,
                _ => match s[i..].find(close) {
                    Some(j) => i + j + close.len(),
                    None => break,
                },
            };
            s.replace_range(i..end, "");
        }
    }
    // Drop an XML declaration or doctype before the root element.
    let mut s = s.trim_start();
    while s.starts_with("<?") || s.starts_with("<!DOCTYPE") || s.starts_with("<!doctype") {
        s = s[s.find('>').map_or(s.len(), |i| i + 1)..].trim_start();
    }
    s.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")
}

/// Handle one request; `Err((code, message))` becomes a JSON-RPC error.
pub fn handle(info: &ServerInfo, tools: &mut dyn Tools, method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION);
            let version = if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&requested) { requested } else { PROTOCOL_VERSION };
            let mut capabilities = json!({"tools": {"listChanged": false}});
            if !tools.resources().is_empty() {
                capabilities["resources"] = json!({"subscribe": false, "listChanged": false});
            }
            Ok(json!({
                "protocolVersion": version,
                "capabilities": capabilities,
                "serverInfo": {"name": info.name, "version": info.version},
                "instructions": info.instructions,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools.tools()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).ok_or((-32602, "name is required".to_string()))?;
            let args = params.get("arguments").cloned().unwrap_or(Value::Object(Map::new()));
            let res = tools.call_result(name, &args).unwrap_or_else(|| Err(format!("unknown tool {name}")));
            Ok(match res {
                Ok(result) => result,
                Err(e) => json!({"content": [text(e)], "isError": true}),
            })
        }
        "resources/list" => Ok(json!({"resources": tools.resources()})),
        "resources/templates/list" => Ok(json!({"resourceTemplates": []})),
        "resources/read" => {
            let uri = params.get("uri").and_then(Value::as_str).ok_or((-32602, "uri is required".to_string()))?;
            tools.resource(uri).ok_or((-32002, format!("resource not found: {uri}")))
        }
        "prompts/list" => Ok(json!({"prompts": []})),
        other => Err((-32601, format!("method not found: {other}"))),
    }
}

/// Several tool sets served as one: `tools/list` lists them all, and a call goes to the first
/// set that has the tool.
pub struct Chain(pub Vec<Box<dyn Tools + Send>>);

impl Tools for Chain {
    fn tools(&self) -> Vec<Value> {
        self.0.iter().flat_map(|t| t.tools()).collect()
    }
    fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
        self.0.iter_mut().find_map(|t| t.call(name, args))
    }
    fn call_result(&mut self, name: &str, args: &Value) -> Option<Result<Value, String>> {
        self.0.iter_mut().find_map(|t| t.call_result(name, args))
    }
    fn resources(&self) -> Vec<Value> { self.0.iter().flat_map(|t| t.resources()).collect() }
    fn resource(&self, uri: &str) -> Option<Value> { self.0.iter().find_map(|t| t.resource(uri)) }
}

/// Handle one JSON-RPC message (a request or a notification); `None` for a notification, which
/// gets no reply.
pub fn reply(info: &ServerInfo, tools: &mut dyn Tools, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned().filter(|i| !i.is_null())?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = msg.get("params").cloned().unwrap_or(Value::Object(Map::new()));
    Some(match handle(info, tools, method, &params) {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
    })
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
        // Notifications (no id) get no reply.
        if let Some(r) = reply(info, tools, &msg) {
            write_msg(&stdout, &r)?;
        }
    }
    Ok(())
}

/// What `biocartoon mcp` says it is: the catalog tools and the submission tools.
pub fn catalog_server_info() -> ServerInfo {
    ServerInfo {
        name: "biocartoon",
        version: env!("CARGO_PKG_VERSION"),
        instructions: format!("{CATALOG_INSTRUCTIONS}\n\n{}", crate::mcp_submit::SUBMIT_INSTRUCTIONS),
    }
}

/// Serve the catalog and submission tools on stdin/stdout (`biocartoon mcp` from this crate).
/// Submissions may name local files here, since the server runs on the user's own computer.
pub fn serve_catalog() -> Result<(), String> {
    let mut tools = Chain(vec![Box::new(CatalogTools::default()), Box::new(crate::mcp_submit::SubmitTools { local_files: true }), Box::new(crate::mcp_figure::FigureTools)]);
    serve(&catalog_server_info(), &mut tools)
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
        assert!(t["title"].as_str().is_some_and(|s| !s.is_empty()), "{name}: no title");
        assert_eq!(t["annotations"]["title"], t["title"], "{name}: annotations.title differs");
        assert!(t["annotations"]["readOnlyHint"].is_boolean() && t["annotations"]["destructiveHint"].is_boolean(), "{name}: missing hints");
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
        assert_eq!(ts.len(), 14);
        assert!(ts.iter().all(|t| t["annotations"]["readOnlyHint"] == true));
        check_tool_schemas(&ts);
    }

    #[test]
    fn slims_svg() {
        let svg = "<?xml version=\"1.0\"?>\n<!DOCTYPE svg>\n<!-- Created with Inkscape -->\n<svg viewBox=\"0 0 1 1\">\n  <metadata><rdf:RDF>x</rdf:RDF></metadata>\n  <sodipodi:namedview id=\"n\"/>\n\n  <circle r=\"1\"/><!-- c -->\n</svg>\n";
        assert_eq!(slim_svg(svg), "<svg viewBox=\"0 0 1 1\">\n  <circle r=\"1\"/>\n</svg>");
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

    #[test]
    fn gallery_returns_catalog_records_in_selected_order_over_http() {
        let dir = std::env::temp_dir().join(format!("biocartoon-gallery-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("assets.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("DROP TABLE IF EXISTS assets;
            CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, title TEXT, variant TEXT,
            description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, source_url TEXT,
            png_key TEXT, png_local TEXT, png_width INTEGER, png_height INTEGER, svg_key TEXT, svg_local TEXT);
            INSERT INTO assets VALUES ('a/1','a','A','Neuron','','','cells','[]','PD','Artist One, PD','Artist One',NULL,'a/1.png',NULL,100,100,'a/1.svg',NULL);
            INSERT INTO assets VALUES ('a/2','a','A','Astrocyte','','','cells','[]','CC-BY-4.0','Artist Two, CC BY 4.0','Artist Two',NULL,'a/2.png',NULL,100,100,NULL,NULL);").unwrap();
        drop(db);
        let mut tools = Chain(vec![Box::new(CatalogTools { catalog: Some(Catalog::open(&path).unwrap()), ..Default::default() })]);
        let info = catalog_server_info();
        let req = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "render_assets", "arguments": {"ids": ["a/2", "a/1"]}}});
        let response = crate::mcp_http::respond(&info, &mut tools, "POST", "/mcp", None, req.to_string().as_bytes(), true);
        assert_eq!(response.status, 200);
        let body: Value = serde_json::from_slice(&response.body).unwrap();
        let result = &body["result"];
        assert_eq!(result["isError"], false);
        assert_eq!(result["structuredContent"]["assets"][0]["id"], "a/2");
        assert_eq!(result["structuredContent"]["assets"][1]["id"], "a/1");
        assert_eq!(result["structuredContent"]["assets"][0]["credit"], "Artist Two, CC BY 4.0");
        // Text-only clients get the same records, credits and available downloads.
        let text_records: Value = serde_json::from_str(result["content"][1]["text"].as_str().unwrap()).unwrap();
        assert_eq!(text_records, result["structuredContent"]["assets"]);
        assert!(text_records[1]["svg_url"].as_str().unwrap().ends_with("a/1.svg"));
        assert!(text_records[0].get("svg_url").is_none());
        let missing = handle(&info, &mut tools, "tools/call", &json!({"name": "render_assets", "arguments": {"ids": ["missing"]}})).unwrap();
        assert_eq!(missing["isError"], true);
        assert!(missing.get("structuredContent").is_none());
        drop(tools);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
