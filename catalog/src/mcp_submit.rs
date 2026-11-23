//! MCP tools for contributing artwork to the shared library from an assistant's session:
//! `submit_artwork` sends one image to the submissions Worker (`worker/src/submit.ts`), as
//! `biocartoon upload` does, and `submission_status` follows it through review.
//!
//! The image can come as SVG text (an assistant that draws in SVG, like Claude), as base64, as an
//! https URL, as a file ChatGPT hands over (`openai/fileParams`), or, on the local stdio server
//! only, as a path on the user's computer.

use crate::mcp::{bool_prop, read_only, str_prop, text, tool, Tools};
use crate::upload::{self, Meta, Prepared};
use base64::Engine;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// What an assistant needs to know to submit well (added to the server instructions).
pub const SUBMIT_INSTRUCTIONS: &str = "Contributing artwork: when the library has nothing that fits, you may help the user make their own \
illustration (draw it as a clean, self-contained SVG, or generate an image if you can) and, if they want, submit it to the \
shared library with submit_artwork. Before submitting, show the user the image and the details you will send (title, \
description, tags, credit name, license, whether generative AI was used) and get their explicit go-ahead: they are \
licensing it to everyone. Generated images must be submitted with generative_ai_used=true and license CC0-1.0. Submissions \
wait for a human reviewer and join the catalog after the next publish; submission_status reports where they are. \
Submitting is optional: to use the artwork in a figure now, pass it to compose_figure as an element's svg (or its file \
as image_file), with no review needed.\n\
Adapting a library icon (\"like BA001505 but ...\"): read its markup with asset_svg and edit it, keeping its style. An \
adaptation must keep the original's license terms, so it may be submitted only when that license allows (asset_svg says): \
public-domain and CC0 originals, any way; CC BY, MIT and BSD originals only as CC-BY-4.0 by a person, without generative AI; \
ShareAlike originals not at all. Pass the original's id as derived_from; the user can always keep an adaptation for their \
own figure, crediting the original.";

/// Licenses a submitted adaptation of an asset under `original` may have, or why it can't be
/// submitted. An adaptation is bound by the original's terms: anything goes for public domain and
/// CC0; attribution licenses can be met by CC BY 4.0 (with the original credited); ShareAlike
/// needs CC BY-SA, which submissions don't offer.
pub fn adaptation_licenses(original: &str) -> Result<&'static [&'static str], String> {
    let l = original.to_ascii_uppercase();
    if l == "PD" || l == "CC0-1.0" || l.starts_with("PUBLIC") {
        Ok(&["CC0-1.0", "CC-BY-4.0"])
    } else if l.contains("-SA") {
        Err(format!("its license, {original}, is ShareAlike: adaptations must be shared as CC BY-SA, which the library doesn't take"))
    } else if l.starts_with("CC-BY-") || l == "MIT" || l == "BSD" || l.starts_with("BSD-") {
        Ok(&["CC-BY-4.0"])
    } else if l.is_empty() {
        Err("it has no license on record".into())
    } else {
        Err(format!("its license, {original}, doesn't allow it"))
    }
}

/// One line on whether (and how) an adaptation of an asset under `license` can be submitted.
pub fn adaptation_note(license: &str) -> String {
    match adaptation_licenses(license) {
        Ok(l) if l.len() > 1 => format!("License {license}: an adaptation may be submitted to the library under any license, AI-made or not."),
        Ok(_) => format!(
            "License {license}: an adaptation must credit the original. It may be submitted only as CC-BY-4.0 by a person, without \
             generative AI (AI-made submissions must be CC0, which this license doesn't allow). An AI-made adaptation is fine for \
             the user's own figure, credited to the original."
        ),
        Err(why) => format!("An adaptation can't be submitted to the library: {why}. It is fine for the user's own figure, credited as the license requires."),
    }
}

/// The submission tools. `local_files` lets `submit_artwork` read a path on this computer: true
/// for the stdio server the user runs themselves, false for the hosted HTTP server.
pub struct SubmitTools {
    pub local_files: bool,
}

/// Largest image fetched from a URL or decoded from base64 (raster images are re-encoded and
/// downscaled to the Worker's limits afterwards).
const MAX_INPUT_BYTES: usize = 24 * 1024 * 1024;

impl Tools for SubmitTools {
    fn tools(&self) -> Vec<Value> {
        let mut props = json!({
            "title": str_prop("Name of the illustration, as people would search for it (up to 80 characters), e.g. \"Pyramidal neuron\"."),
            "description": str_prop("What it shows (up to 500 characters)."),
            "category": str_prop("Its category: a BioCartoon category slug (cells, cells.cell_types, lab_and_techniques.lab_equipment, ...) or free text."),
            "tags": {"type": "array", "items": {"type": "string"}, "description": "Words to find it by (up to 20, 40 characters each)."},
            "credit": str_prop("The name to credit (the user's name or handle, as they choose). Default: anonymous. CC-BY-4.0 needs one."),
            "license": {"type": "string", "enum": upload::LICENSES, "description": "CC0-1.0 (anyone may use it, no credit needed) or CC-BY-4.0 (credit required; only for artwork made without generative AI)."},
            "generative_ai_used": bool_prop("Whether generative AI made any part of it. True for anything you drew or generated."),
            "generative_ai_details": str_prop("How generative AI was used, e.g. the model and what the user changed by hand (up to 500 characters)."),
            "rights_confirmed": bool_prop("True only once the user has confirmed they may share this image under the license, and wants it submitted."),
            "email": str_prop("Optional contact address for the reviewers (never published)."),
            "derived_from": str_prop("The id of the library asset this is adapted from, if any (e.g. BA001505). Required for an adaptation: its license decides whether and how it may be submitted, and the original's credit line is added to the description."),
            "svg": str_prop("The illustration as SVG markup (one complete <svg> element with a viewBox; no scripts, external links or web fonts)."),
            "image_base64": str_prop("A PNG, JPEG, WebP or GIF, base64-encoded (a data: URL works too)."),
            "image_url": str_prop("An https URL the image can be downloaded from."),
            "image": {
                "type": "object",
                "description": "An image file from the conversation (ChatGPT passes generated or uploaded images this way).",
                "properties": {"download_url": {"type": "string"}, "file_id": {"type": "string"}},
                "required": ["download_url"],
            },
        });
        if self.local_files {
            props["file_path"] = str_prop("Path of an image file on this computer (SVG, PNG, JPEG, WebP, GIF, BMP, TIFF).");
        }
        let sources = if self.local_files { "svg, image, image_url, image_base64 or file_path" } else { "svg, image, image_url or image_base64" };
        let mut submit = tool(
            "submit_artwork",
            "Submit artwork",
            &format!(
                "Submit one illustration to the shared BioCartoon library. Give the image as exactly one of {sources}. \
                 It is held for review and published once a reviewer approves it; returns the submission id. Only call this \
                 after showing the user the image and these details and getting their go-ahead (rights_confirmed)."
            ),
            props,
            &["title", "license", "generative_ai_used", "rights_confirmed"],
        );
        submit["annotations"] = json!({"title": "Submit artwork", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true});
        // ChatGPT passes conversation files (generated or uploaded images) in `image`.
        submit["_meta"] = json!({"openai/fileParams": ["image"]});
        vec![
            submit,
            read_only(tool(
                "submission_status",
                "Check submission status",
                "Where submissions are in review: pending, approved (it joins the catalog at the next publish) or rejected.",
                json!({"ids": {"type": "array", "items": {"type": "string"}, "description": "Submission ids from submit_artwork."}}),
                &["ids"],
            )),
        ]
    }

    fn call(&mut self, name: &str, args: &Value) -> Option<Result<Vec<Value>, String>> {
        match name {
            "submit_artwork" => Some(self.submit(args)),
            "submission_status" => Some(status(args)),
            _ => None,
        }
    }
}

impl SubmitTools {
    fn submit(&self, args: &Value) -> Result<Vec<Value>, String> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
        if args.get("rights_confirmed").and_then(Value::as_bool) != Some(true) {
            return Err("rights_confirmed must be true: show the user the image and details, and ask them to confirm they may share it \
                        under this license and want it submitted"
                .into());
        }
        let ai = args.get("generative_ai_used").and_then(Value::as_bool).ok_or("generative_ai_used is required (true or false)")?;
        let license = s("license");
        if !upload::LICENSES.contains(&license.as_str()) {
            return Err(format!("license must be one of {}", upload::LICENSES.join(", ")));
        }
        if ai && license != "CC0-1.0" {
            return Err("artwork made with generative AI can only be shared as CC0-1.0".into());
        }
        let title = s("title");
        if title.is_empty() {
            return Err("title is required".into());
        }
        let tags: Vec<String> = match args.get("tags") {
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect(),
            Some(Value::String(t)) => crate::catalog::parse_tags(t),
            _ => Vec::new(),
        };
        crate::catalog::check_tags(&tags)?;
        let credit = Some(s("credit")).filter(|c| !c.is_empty()).unwrap_or_else(|| "anonymous".into());
        if license == "CC-BY-4.0" && credit == "anonymous" {
            return Err("CC-BY-4.0 needs a credit name: ask the user what name to credit, or use CC0-1.0".into());
        }
        let mut description = s("description");
        if let Some(id) = Some(s("derived_from")).filter(|d| !d.is_empty()) {
            let original = crate::query::Catalog::open_default()?.get(&id)?.ok_or_else(|| format!("derived_from: no asset {id}"))?;
            let note = derived_note(&original, &license, ai)?;
            let room = 500usize.saturating_sub(note.chars().count() + 1);
            description = description.chars().take(room).collect::<String>().trim_end().to_string();
            description = if description.is_empty() { note } else { format!("{description} {note}") };
        }
        let file = self.image(args)?;
        let meta = Meta {
            title: title.chars().take(80).collect(),
            description: description.chars().take(500).collect(),
            category: s("category").chars().take(60).collect(),
            tags,
            author: credit,
            license,
            generative_ai_used: Some(ai),
            generative_ai_details: if ai { s("generative_ai_details").chars().take(500).collect() } else { String::new() },
            official: false,
            replaces: None,
            layers: Vec::new(),
        };
        let email = s("email");
        let mut meta_json = serde_json::to_value(&meta).map_err(|e| e.to_string())?;
        if !email.is_empty() {
            meta_json["email"] = json!(email);
        }
        // The hosted server sends every user's submissions from one address; its token lets the
        // Worker count them apart from that address's own limit (worker/src/submit.ts).
        let token = std::env::var("BIOCARTOON_MCP_TOKEN").ok().filter(|t| !t.is_empty());
        let headers: Vec<(&str, &str)> = token.as_deref().map(|t| vec![("X-MCP-Token", t)]).unwrap_or_default();
        let id = upload::submit_meta(&upload::submit_url(), &meta_json, &file, upload::upload_key(None).as_deref(), &headers).map_err(|r| match r.status {
            429 => format!("{} (the daily submission limit)", r.message),
            _ => r.message,
        })?;
        let kind = if file.svg { "SVG" } else { "PNG" };
        Ok(vec![
            text(format!(
                "Submitted \"{}\" ({kind}) as {id}. It is waiting for a reviewer; once approved it joins the catalog at the next publish \
                 (usually within a few days) under {}, credited to {}. Check on it with submission_status.",
                meta.title, meta.license, meta.author
            )),
            crate::mcp::pretty(&json!({"id": id, "status": "pending"})),
        ])
    }

    /// The image the arguments name, ready to send.
    fn image(&self, args: &Value) -> Result<Prepared, String> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty());
        let file_url = args.get("image").and_then(|v| v.get("download_url")).and_then(Value::as_str).filter(|v| !v.is_empty());
        let local = s("file_path").filter(|_| self.local_files);
        if s("file_path").is_some() && !self.local_files {
            return Err("file_path only works with the local server (`biocartoon mcp`); give the image as svg, image, image_url or image_base64".into());
        }
        let given = [s("svg").is_some(), s("image_base64").is_some(), s("image_url").is_some(), file_url.is_some(), local.is_some()];
        match given.iter().filter(|g| **g).count() {
            0 => return Err("no image: give it as svg, image, image_url or image_base64".into()),
            1 => {}
            _ => return Err("give the image once: only one of svg, image, image_url, image_base64, file_path".into()),
        }
        let (name, bytes) = if let Some(svg) = s("svg") {
            ("image.svg", svg.as_bytes().to_vec())
        } else if let Some(b64) = s("image_base64") {
            let b64 = b64.split_once("base64,").map_or(b64, |(_, d)| d);
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.split_whitespace().collect::<String>())
                .map_err(|e| format!("image_base64 is not valid base64: {e}"))?;
            (sniff(&bytes), bytes)
        } else if let Some(url) = s("image_url").or(file_url) {
            let bytes = fetch_image(url)?;
            (sniff(&bytes), bytes)
        } else {
            let p = Path::new(local.unwrap());
            let bytes = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
            (if sniff(&bytes) == "image.svg" { "image.svg" } else { "image.png" }, bytes)
        };
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(format!("the image is {:.1} MB; the most this takes is {} MB", bytes.len() as f64 / 1e6, MAX_INPUT_BYTES / (1024 * 1024)));
        }
        if name == "image.svg" {
            upload::parse_svg(&bytes).map_err(|e| format!("the SVG doesn't parse: {e}"))?;
        }
        let (prepared, _) = upload::prepare_bytes(Path::new(name), bytes, &[])?;
        Ok(prepared)
    }
}

/// The sentence crediting `original` in an adaptation's description, once its license allows the
/// adaptation to be submitted as `license` (`ai`: made with generative AI).
fn derived_note(original: &crate::query::Asset, license: &str, ai: bool) -> Result<String, String> {
    let allowed = adaptation_licenses(&original.license).map_err(|why| format!("{} can't be adapted for the library: {why}. The user may still use the adaptation in their own figure, crediting: {}", original.id, original.credit))?;
    if !allowed.contains(&license) {
        return Err(if ai {
            format!(
                "{} is {}: an adaptation must keep crediting it, so it can't be CC0, and AI-made submissions must be CC0. It can't be \
                 submitted, but the user may use it in their own figure, crediting: {}",
                original.id, original.license, original.credit
            )
        } else {
            format!("{} is {}: an adaptation of it may be submitted only as {}", original.id, original.license, allowed.join(" or "))
        });
    }
    Ok(format!("Adapted from {} (BioCartoon {}).", original.credit.trim_end_matches('.'), original.id))
}

/// `image.svg` for SVG markup, `image.png` for anything else (decoded as a raster image).
fn sniff(bytes: &[u8]) -> &'static str {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with("<svg") || ((head.starts_with("<?xml") || head.starts_with("<!--") || head.starts_with("<!doctype")) && head.contains("<svg")) {
        "image.svg"
    } else {
        "image.png"
    }
}

/// Download an image from an https URL that isn't this machine or a private network.
fn fetch_image(url: &str) -> Result<Vec<u8>, String> {
    let rest = url.strip_prefix("https://").ok_or("image_url must be an https:// URL")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    let host = if host.starts_with('[') { host.split(']').next().unwrap_or(host).trim_start_matches('[') } else { host.split(':').next().unwrap_or(host) };
    if private_host(host) {
        return Err(format!("won't download from {host}: not a public address"));
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(60))).http_status_as_error(false).build().into();
    let mut res = agent.get(url).header("User-Agent", concat!("biocartoon-mcp/", env!("CARGO_PKG_VERSION"))).call().map_err(|e| format!("couldn't download the image: {e}"))?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("couldn't download the image: HTTP {status}"));
    }
    res.body_mut().with_config().limit(MAX_INPUT_BYTES as u64).read_to_vec().map_err(|e| format!("couldn't download the image: {e}"))
}

fn private_host(host: &str) -> bool {
    let h = host.to_lowercase();
    if h.is_empty() || h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") {
        return true;
    }
    match h.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() || ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unspecified() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80,
        Err(_) => false,
    }
}

fn status(args: &Value) -> Result<Vec<Value>, String> {
    let ids: Vec<&str> = args.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    if ids.is_empty() {
        return Err("ids is required".into());
    }
    let url = format!("{}/status?ids={}&detail=1", upload::submit_url().trim_end_matches('/'), ids.iter().take(100).copied().collect::<Vec<_>>().join(","));
    let body = crate::query::fetch_url(&url)?;
    let found: Value = serde_json::from_slice(&body).map_err(|e| format!("unexpected reply from the submission server: {e}"))?;
    Ok(vec![crate::mcp::pretty(&status_rows(&ids, &found))])
}

/// One `{id, status, reason?}` per id from a `/status?detail=1` reply (a plain `{"<id>": "<status>"}`
/// reply, from an older server, also works).
fn status_rows(ids: &[&str], found: &Value) -> Vec<Value> {
    ids.iter()
        .map(|id| {
            let f = found.get(*id);
            let status = f.and_then(|f| f.get("status").or(Some(f))).and_then(Value::as_str).unwrap_or("unknown id");
            match f.and_then(|f| f.get("reason")).and_then(Value::as_str).filter(|r| !r.is_empty()) {
                Some(reason) => json!({"id": id, "status": status, "reason": reason}),
                None => json!({"id": id, "status": status}),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_rows_read_both_reply_forms() {
        let detail = json!({"a": {"status": "rejected", "reason": "Too blurry"}, "b": {"status": "pending"}});
        assert_eq!(status_rows(&["a", "b", "c"], &detail), vec![json!({"id": "a", "status": "rejected", "reason": "Too blurry"}), json!({"id": "b", "status": "pending"}), json!({"id": "c", "status": "unknown id"})]);
        assert_eq!(status_rows(&["a"], &json!({"a": "approved"})), vec![json!({"id": "a", "status": "approved"})]);
    }

    #[test]
    fn schemas_and_file_params() {
        let ts = SubmitTools { local_files: false }.tools();
        crate::mcp::check_tool_schemas(&ts);
        assert!(ts[0]["inputSchema"]["properties"].get("file_path").is_none());
        assert_eq!(ts[0]["_meta"]["openai/fileParams"][0], "image");
        assert!(SubmitTools { local_files: true }.tools()[0]["inputSchema"]["properties"].get("file_path").is_some());
    }

    #[test]
    fn refuses_before_sending() {
        let t = SubmitTools { local_files: false };
        let base = json!({"title": "Neuron", "license": "CC0-1.0", "generative_ai_used": true, "rights_confirmed": true, "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/>"});
        let with = |k: &str, v: Value| {
            let mut a = base.clone();
            a[k] = v;
            t.submit(&a).unwrap_err()
        };
        assert!(with("rights_confirmed", json!(false)).contains("rights_confirmed"));
        assert!(with("license", json!("CC-BY-4.0")).contains("CC0"));
        assert!(with("license", json!("MIT")).contains("license"));
        assert!(with("image_url", json!("https://example.com/a.png")).contains("only one"));
        assert!(with("file_path", json!("/etc/passwd")).contains("local server"));
        assert!(with("svg", json!("<svg")).contains("SVG"));
        let mut a = base.clone();
        a["generative_ai_used"] = json!(false);
        a["license"] = json!("CC-BY-4.0");
        assert!(t.submit(&a).unwrap_err().contains("credit"));
    }

    #[test]
    fn adaptation_follows_the_original_license() {
        assert_eq!(adaptation_licenses("PD").unwrap().len(), 2);
        assert_eq!(adaptation_licenses("CC0-1.0").unwrap().len(), 2);
        for l in ["CC-BY-4.0", "CC-BY-3.0", "MIT", "BSD"] {
            assert_eq!(adaptation_licenses(l).unwrap(), ["CC-BY-4.0"], "{l}");
        }
        for l in ["CC-BY-SA-4.0", "CC-BY-SA-3.0", "", "proprietary"] {
            assert!(adaptation_licenses(l).is_err(), "{l}");
        }
        let a = |license: &str| crate::query::Asset { license: license.into(), ..crate::query::Asset::example() };
        assert!(derived_note(&a("PD"), "CC0-1.0", true).unwrap().starts_with("Adapted from"));
        assert!(derived_note(&a("CC-BY-4.0"), "CC0-1.0", true).unwrap_err().contains("must be CC0"));
        assert!(derived_note(&a("CC-BY-4.0"), "CC0-1.0", false).unwrap_err().contains("only as CC-BY-4.0"));
        assert!(derived_note(&a("CC-BY-4.0"), "CC-BY-4.0", false).is_ok());
        assert!(derived_note(&a("CC-BY-SA-4.0"), "CC0-1.0", true).unwrap_err().contains("ShareAlike"));
    }

    #[test]
    fn sniffs_svg_and_blocks_private_hosts() {
        assert_eq!(sniff(b"<?xml version='1.0'?>\n<svg/>"), "image.svg");
        assert_eq!(sniff(b"  <svg xmlns='x'/>"), "image.svg");
        assert_eq!(sniff(b"\x89PNG\r\n"), "image.png");
        for h in ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "metadata.internal"] {
            assert!(private_host(h), "{h}");
        }
        assert!(!private_host("files.oaiusercontent.com") && !private_host("8.8.8.8"));
        assert!(fetch_image("http://example.com/a.png").unwrap_err().contains("https"));
        assert!(fetch_image("https://user@127.0.0.1:8080/x").unwrap_err().contains("public"));
        assert!(fetch_image("https://[::1]/x").unwrap_err().contains("public"));
    }
}
