//! Whole figures: `compose_figure`, `open_in_biocartoon` and `export_figure`. They run on the hosted
//! server (`worker/src/mcp_figure.ts`), which lays a figure out from the public catalog and keeps the
//! editor links; this server lists the same tools (`figure_tools.json`) and relays calls there, so
//! a local `biocartoon mcp` and the hosted endpoint offer the same figures.
//!
//! The local server also lets an element's picture be a file on this computer (`file_path`): it is
//! read here, shrunk to what the hosted server takes, and sent inline (`svg` or `image_base64`).
use crate::mcp::Tools;
use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

const DEFS: &str = include_str!("figure_tools.json");
const HOSTED: &str = "https://mcp.biocartoon.com/mcp";

/// Where calls go: `BIOCARTOON_MCP_URL`, or the hosted server.
fn endpoint() -> String {
    std::env::var("BIOCARTOON_MCP_URL").ok().filter(|u| u.starts_with("https://") || u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost")).unwrap_or_else(|| HOSTED.into())
}

/// The tool definitions; with `local_files`, figure elements also take a `file_path`.
pub fn definitions(local_files: bool) -> Vec<Value> {
    let mut defs = serde_json::from_str::<Vec<Value>>(DEFS).expect("figure_tools.json is a list of tools");
    if local_files {
        let file_path = json!({"type": "string", "description": "Path of an image file on this computer to use as this element's picture (SVG, PNG, JPEG, WebP, GIF, BMP, TIFF)."});
        for t in &mut defs {
            for_each_element_schema(&mut t["inputSchema"], &mut |props| {
                props["file_path"] = file_path.clone();
            });
        }
    }
    defs
}

/// Calls `f` with the properties of every figure element schema under `schema`.
fn for_each_element_schema(schema: &mut Value, f: &mut dyn FnMut(&mut Value)) {
    if let Some(items) = schema.pointer_mut("/properties/elements/items/properties") {
        f(items);
    }
    match schema {
        Value::Object(m) => m.values_mut().for_each(|v| for_each_element_schema(v, f)),
        Value::Array(a) => a.iter_mut().for_each(|v| for_each_element_schema(v, f)),
        _ => {}
    }
}

/// Largest picture the hosted server takes (worker/src/mcp_images.ts MAX_UPLOAD).
const HOSTED_MAX: usize = 2 * 1024 * 1024;

/// A local image file as the element fields the hosted server reads: SVG as markup, anything else
/// as a PNG, downscaled until it fits.
fn inline_file(path: &str) -> Result<(&'static str, String), String> {
    let p = std::path::Path::new(path);
    let bytes = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_lowercase();
    if head.trim_start_matches('\u{feff}').trim_start().starts_with('<') && head.contains("<svg") {
        if bytes.len() > HOSTED_MAX {
            return Err(format!("{}: the SVG is {:.1} MB; figures take SVGs up to 2 MB", p.display(), bytes.len() as f64 / 1e6));
        }
        crate::upload::parse_svg(&bytes).map_err(|e| format!("{}: the SVG doesn't parse: {e}", p.display()))?;
        return Ok(("svg", String::from_utf8(bytes).map_err(|_| format!("{}: the SVG isn't UTF-8 text", p.display()))?));
    }
    let img = image::load_from_memory(&bytes).map_err(|e| format!("{}: {e}", p.display()))?.to_rgba8();
    for side in [2048u32, 1536, 1024, 768, 512] {
        let (w, h) = img.dimensions();
        let scaled = if w.max(h) > side {
            let s = side as f32 / w.max(h) as f32;
            image::imageops::resize(&img, ((w as f32 * s) as u32).max(1), ((h as f32 * s) as u32).max(1), image::imageops::FilterType::Lanczos3)
        } else {
            img.clone()
        };
        let mut png = Vec::new();
        scaled.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).map_err(|e| e.to_string())?;
        if png.len() <= HOSTED_MAX {
            return Ok(("image_base64", base64::engine::general_purpose::STANDARD.encode(png)));
        }
    }
    Err(format!("{}: too detailed to fit in 2 MB as PNG even at 512 px", p.display()))
}

/// `args` with every element's `file_path` replaced by the picture itself.
fn inline_files(args: &Value) -> Result<Value, String> {
    let mut args = args.clone();
    for ptr in ["/elements", "/figure/elements"] {
        let Some(Value::Array(elements)) = args.pointer_mut(ptr) else { continue };
        for e in elements.iter_mut() {
            let Some(path) = e.get("file_path").and_then(Value::as_str).map(str::to_string) else { continue };
            let (key, value) = inline_file(&path)?;
            let m = e.as_object_mut().expect("an element with a file_path is an object");
            m.remove("file_path");
            m.insert(key.into(), json!(value));
        }
    }
    Ok(args)
}

/// The figure tools. `local_files` lets elements name a file on this computer: true for the stdio
/// server the user runs themselves, false for the hosted HTTP server.
pub struct FigureTools {
    pub local_files: bool,
}

impl FigureTools {
    fn relay(&self, name: &str, args: &Value) -> Result<Value, String> {
        let has_file = ["/elements", "/figure/elements"].iter().any(|p| args.pointer(p).and_then(Value::as_array).is_some_and(|a| a.iter().any(|e| e.get("file_path").is_some())));
        let inlined;
        let args = if has_file {
            if !self.local_files {
                return Err("file_path only works with the local server (`biocartoon mcp`); give the picture as svg, image_url or image_base64".into());
            }
            inlined = inline_files(args)?;
            &inlined
        } else {
            args
        };
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
        definitions(self.local_files)
    }

    fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
        self.call_result(name, args).map(|r| r.map(|v| v["content"].as_array().cloned().unwrap_or_default()))
    }

    fn call_result(&mut self, name: &str, args: &Value) -> Option<Result<Value, String>> {
        definitions(false).iter().any(|t| t["name"] == name).then(|| self.relay(name, args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_are_valid_tools_with_the_gallery() {
        let defs = definitions(false);
        let names: Vec<&str> = defs.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(names, ["compose_figure", "open_in_biocartoon", "export_figure"]);
        for t in &defs {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(t["description"].as_str().unwrap().len() > 40);
            assert!(t["title"].is_string() && t["annotations"]["title"] == t["title"]);
        }
        assert_eq!(defs[0]["_meta"]["ui"]["resourceUri"], crate::mcp_ui::URI);
    }

    #[test]
    fn unknown_tools_pass_through() {
        assert!(FigureTools { local_files: true }.call_result("search_assets", &json!({})).is_none());
    }

    #[test]
    fn only_the_local_server_takes_file_paths() {
        let has = |defs: &[Value]| defs[0]["inputSchema"]["properties"]["elements"]["items"]["properties"].get("file_path").is_some();
        assert!(has(&definitions(true)) && !has(&definitions(false)));
        // In a figure being edited too.
        assert!(definitions(true)[1]["inputSchema"]["properties"]["figure"]["properties"]["elements"]["items"]["properties"].get("file_path").is_some());
        let err = FigureTools { local_files: false }.call_result("compose_figure", &json!({"elements": [{"file_path": "/x.png"}]})).unwrap().unwrap_err();
        assert!(err.contains("local server"), "{err}");
    }

    #[test]
    fn local_files_are_sent_inline() {
        let dir = std::env::temp_dir().join(format!("bc-figure-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let svg = dir.join("neuron.svg");
        std::fs::write(&svg, r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20"><circle cx="5" cy="5" r="4"/></svg>"#).unwrap();
        let png = dir.join("cell.jpg");
        image::RgbImage::from_pixel(3000, 1000, image::Rgb([200, 30, 30])).save_with_format(&png, image::ImageFormat::Jpeg).unwrap();
        let args = json!({"figure": {"elements": [{"label": "Neuron", "file_path": svg}, {"label": "Cell", "file_path": png}, {"query": "astrocyte"}]}});
        let out = inline_files(&args).unwrap();
        let els = out["figure"]["elements"].as_array().unwrap();
        assert!(els[0]["svg"].as_str().unwrap().starts_with("<svg") && els[0].get("file_path").is_none());
        let bytes = base64::engine::general_purpose::STANDARD.decode(els[1]["image_base64"].as_str().unwrap()).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2048, 682), "a JPEG becomes a PNG no wider than 2048 px");
        assert_eq!(els[2], json!({"query": "astrocyte"}));
        assert!(inline_files(&json!({"elements": [{"file_path": dir.join("missing.png")}]})).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
