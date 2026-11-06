//! `biocartoon upload`: submit images to the shared library. Each one is POSTed to the submissions
//! Worker (`worker/src/submit.ts`), which validates it, filters profanity, rate limits and holds it
//! in the private pending bucket. Nothing reaches the catalog until it is approved and published.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The deployed `biocartoon-submit` Worker. `BIOCARTOON_SUBMIT_URL` overrides it.
pub const DEFAULT_SUBMIT_URL: &str = "https://api.biocartoon.com";

/// Limits the Worker enforces (worker/src/limits.ts); checked here first for clearer errors.
pub const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SVG_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_IMAGE_SIDE: u32 = 4096;
/// Submissions the Worker accepts per address per rolling day, and with the upload key.
pub const MAX_PER_DAY: usize = 20;
pub const MAX_PER_DAY_WITH_KEY: usize = 9999;
pub const LICENSES: [&str; 2] = ["CC0-1.0", "CC-BY-4.0"];

/// File extensions `upload` reads (what the `image` crate decodes here, and SVG).
const IMAGE_EXTENSIONS: [&str; 10] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "ico", "svg"];

/// The metadata the Worker expects in the `meta` field.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Meta {
    pub title: String,
    pub description: String,
    pub category: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    pub author: String,
    pub license: String,
    /// `Some(true)` with `--ai` (or `--ai-description`), `Some(false)` with `--no-ai`; left out
    /// (not specified) otherwise. The Worker takes CC BY 4.0 only with `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generative_ai_used: Option<bool>,
    /// `--ai-description`: how generative AI was used (with `--ai` only; up to 500 characters).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub generative_ai_details: String,
    /// `--official-biocartoon`: asks for it to go in the official BioCartoon library; a reviewer
    /// decides, and the author is unchanged either way.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub official: bool,
    /// `--update ID`: the approved upload (its submission id) this is a new version of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
    /// Named colour layers of an SVG (an update keeps those of the version it replaces whose
    /// colours the new SVG still has).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<Layer>,
}

/// A named colour layer of an SVG upload.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Layer {
    pub name: String,
    pub colors: Vec<String>,
}

/// The upload key: `--key`, else `BIOCARTOON_UPLOAD_KEY`.
pub fn upload_key(flag: Option<&str>) -> Option<String> {
    flag.map(str::to_string).or_else(|| std::env::var("BIOCARTOON_UPLOAD_KEY").ok()).map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// The submission id of an upload named as `user/<id>` or `<id>` (catalog ids like `UG000123`
/// are looked up in the catalog instead); `None` if it isn't one.
pub fn upload_slug(id: &str) -> Option<&str> {
    let s = id.trim().strip_prefix("user/").unwrap_or(id.trim());
    let s = s.strip_suffix(".png").or_else(|| s.strip_suffix(".svg")).unwrap_or(s);
    let ok = !s.is_empty()
        && s.len() <= 101
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        // a catalog id, lowercased by mistake, is not a submission id
        && !(s.len() >= 3 && s.as_bytes()[..2].iter().all(u8::is_ascii_lowercase) && s[2..].bytes().all(|b| b.is_ascii_digit()));
    ok.then_some(s)
}

/// The published metadata (sidecar) of approved upload `slug`, from the asset bucket.
pub fn fetch_sidecar(base_url: &str, slug: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/user/{slug}.json", base_url.trim_end_matches('/'));
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).http_status_as_error(false).build().into();
    let mut res = agent.get(&url).call().map_err(|e| format!("couldn't reach {url}: {e}"))?;
    match res.status().as_u16() {
        200 => serde_json::from_str(&res.body_mut().with_config().limit(64 * 1024).read_to_string().map_err(|e| e.to_string())?).map_err(|e| format!("{url}: {e}")),
        404 | 403 => Err(format!("user/{slug} is not an approved upload (no {url})")),
        c => Err(format!("{url}: HTTP {c}")),
    }
}

/// The published image of an approved upload, from the asset bucket: its SVG if it has one, else its
/// PNG (`--update ID` with no file resubmits it, so only the metadata changes). Returns its key
/// (`user/<id>.svg` or `.png`) and bytes.
pub fn fetch_published(base_url: &str, sidecar: &serde_json::Value) -> Result<(String, Vec<u8>), String> {
    let key = sidecar["svg_key"].as_str().or_else(|| sidecar["png_key"].as_str()).ok_or("the upload's published metadata names no image")?;
    let url = format!("{}/{key}", base_url.trim_end_matches('/'));
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(120))).http_status_as_error(false).build().into();
    let mut res = agent.get(&url).call().map_err(|e| format!("couldn't reach {url}: {e}"))?;
    match res.status().as_u16() {
        200 => Ok((key.to_string(), res.body_mut().with_config().limit(32 * 1024 * 1024).read_to_vec().map_err(|e| format!("{url}: {e}"))?)),
        c => Err(format!("couldn't download the current image ({url}: HTTP {c}); give the file to submit")),
    }
}

/// The layers of `old` whose every colour the new SVG still has.
pub fn kept_layers(old: &[Layer], new_colors: &[String]) -> Vec<Layer> {
    old.iter().filter(|l| !l.colors.is_empty() && l.colors.iter().all(|c| new_colors.contains(c))).cloned().collect()
}

/// Call the Worker's upload-key routes (`/keys`, `/keys/<id>`) with the master key.
pub fn keys_request(url: &str, method: &str, path: &str, body: Option<serde_json::Value>, key: &str) -> Result<serde_json::Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).http_status_as_error(false).build().into();
    let full = format!("{}{path}", url.trim_end_matches('/'));
    let res = match (method, body) {
        ("POST", Some(b)) => agent.post(&full).header("X-Upload-Key", key).header("Content-Type", "application/json").send(b.to_string()),
        ("DELETE", _) => agent.delete(&full).header("X-Upload-Key", key).call(),
        _ => agent.get(&full).header("X-Upload-Key", key).call(),
    };
    let mut res = res.map_err(|e| format!("couldn't reach the submission server: {e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().with_config().limit(1024 * 1024).read_to_string().unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    if (200..300).contains(&status) {
        return Ok(v);
    }
    Err(v["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("the submission server answered HTTP {status}")))
}

/// `#rgb` or `#rrggbb` (the `#` optional) as lowercase `#rrggbb`.
pub fn parse_hex(s: &str) -> Option<String> {
    let h = s.trim().trim_start_matches('#');
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    match h.len() {
        6 => Some(format!("#{}", h.to_lowercase())),
        3 => Some(format!("#{}", h.to_lowercase().chars().flat_map(|c| [c, c]).collect::<String>())),
        _ => None,
    }
}

/// `--layer-color-map OLD:NEW,...`: pairs of hex colours.
pub fn parse_color_map(values: &[&str]) -> Result<Vec<(String, String)>, String> {
    let mut map: Vec<(String, String)> = Vec::new();
    for pair in values.iter().flat_map(|v| v.split(',')).map(str::trim).filter(|p| !p.is_empty()) {
        let (old, new) = pair.split_once(':').ok_or_else(|| format!("{pair}: expected OLD:NEW, e.g. #ff0000:#00aa00"))?;
        let bad = |c: &str| format!("{c}: not a hex colour (#rgb or #rrggbb)");
        let (old, new) = (parse_hex(old).ok_or_else(|| bad(old))?, parse_hex(new).ok_or_else(|| bad(new))?);
        if map.iter().any(|(o, _)| *o == old) {
            return Err(format!("{old} is mapped twice"));
        }
        map.push((old, new));
    }
    Ok(map)
}

/// Replace every hex colour in an SVG that `map` names (`#rgb` and `#rrggbb`, any case, in
/// attributes and CSS alike), all at once so `a:b,b:a` swaps them. Returns the new SVG and the
/// `OLD` colours that never occurred.
pub fn recolor_svg(svg: &str, map: &[(String, String)]) -> (String, Vec<String>) {
    let mut out = String::with_capacity(svg.len());
    let mut used = vec![false; map.len()];
    let b = svg.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'#' {
            let run = b[i + 1..].iter().take_while(|c| c.is_ascii_hexdigit()).count();
            // A colour is exactly 3 or 6 hex digits not followed by more name characters (so
            // `#abc` in `url(#abcdef-grad)` or an id like `#face1x` is left alone).
            let next = b.get(i + 1 + run).copied();
            let ends = !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
            if (run == 3 || run == 6) && ends {
                let token = &svg[i..i + 1 + run];
                if let Some(k) = parse_hex(token).and_then(|c| map.iter().position(|(o, _)| *o == c)) {
                    used[k] = true;
                    out.push_str(&map[k].1);
                    i += 1 + run;
                    continue;
                }
            }
        }
        let ch = svg[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    let missing = map.iter().zip(used).filter(|(_, u)| !u).map(|((o, _), _)| o.clone()).collect();
    (out, missing)
}

/// An SVG's layers as the editor's Layers panel finds them: every colour a visible shape is
/// painted with (fills, strokes, gradient stops), as `#rrggbb`, most of the drawing first.
pub fn svg_colors(tree: &usvg::Tree) -> Vec<String> {
    fn add(paint: &usvg::Paint, area: f32, out: &mut Vec<(String, f32)>) {
        let mut one = |c: usvg::Color, a: f32| {
            let hex = format!("#{:02x}{:02x}{:02x}", c.red, c.green, c.blue);
            match out.iter_mut().find(|(o, _)| *o == hex) {
                Some((_, w)) => *w += a,
                None => out.push((hex, a)),
            }
        };
        match paint {
            usvg::Paint::Color(c) => one(*c, area),
            usvg::Paint::LinearGradient(g) => g.stops().iter().for_each(|s| one(s.color(), area / g.stops().len() as f32)),
            usvg::Paint::RadialGradient(g) => g.stops().iter().for_each(|s| one(s.color(), area / g.stops().len() as f32)),
            usvg::Paint::Pattern(_) => {}
        }
    }
    fn walk(g: &usvg::Group, out: &mut Vec<(String, f32)>) {
        for node in g.children() {
            match node {
                usvg::Node::Group(g) => walk(g, out),
                usvg::Node::Text(t) => walk(t.flattened(), out),
                usvg::Node::Path(p) if p.is_visible() => {
                    let b = p.abs_bounding_box();
                    let area = b.width() * b.height();
                    if let Some(f) = p.fill() {
                        add(f.paint(), area, out);
                    }
                    if let Some(s) = p.stroke() {
                        add(s.paint(), area * 0.1, out);
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(tree.root(), &mut out);
    out.sort_by(|a, b| b.1.total_cmp(&a.1));
    out.into_iter().map(|(c, _)| c).collect()
}

/// Parse an SVG as the editor does (system fonts loaded, so text keeps its look as outlines).
pub fn parse_svg(bytes: &[u8]) -> Result<usvg::Tree, String> {
    let mut opt = usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    usvg::Tree::from_data(bytes, &opt).map_err(|e| e.to_string())
}

/// Recolour an SVG's layers by `map`, as changing a layer's colour in the editor does. The file
/// is rewritten in usvg's normal form first, which states every paint as a `#rrggbb` attribute
/// (whether the source wrote `white`, `rgb()`, a CSS class or an inherited fill). Returns the
/// new SVG and the `OLD` colours that are not among its layers.
pub fn recolor_layers(bytes: &[u8], map: &[(String, String)]) -> Result<(Vec<u8>, Vec<String>), String> {
    let tree = parse_svg(bytes)?;
    let colors = svg_colors(&tree);
    let missing = map.iter().map(|(o, _)| o).filter(|o| !colors.contains(o)).cloned().collect();
    let (svg, _) = recolor_svg(&tree.to_string(&usvg::WriteOptions::default()), map);
    Ok((svg.into_bytes(), missing))
}

pub fn submit_url() -> String {
    std::env::var("BIOCARTOON_SUBMIT_URL").ok().filter(|u| !u.is_empty()).unwrap_or_else(|| DEFAULT_SUBMIT_URL.into())
}

/// The image files among `paths`: files as given, and folders searched recursively (sorted, hidden
/// entries skipped).
pub fn collect_images(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    for p in paths {
        let p = PathBuf::from(p);
        if p.is_dir() {
            walk(&p, &mut out)?;
        } else if p.is_file() {
            out.push(p);
        } else {
            return Err(format!("{}: no such file or folder", p.display()));
        }
    }
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut entries: Vec<PathBuf> =
        std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort();
    for p in entries {
        if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.')) {
            continue;
        }
        if p.is_dir() {
            walk(&p, out)?;
        } else if is_image(&p) {
            out.push(p);
        }
    }
    Ok(())
}

pub fn is_image(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
}

/// A title from a file name: `t_cell-receptor.png` -> `t cell receptor`.
pub fn title_from_path(p: &Path) -> String {
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    stem.replace(['_', '-'], " ").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect()
}

/// What `upload` sends for one file: an SVG as is (the catalog renders its PNG when it is
/// published), anything else as PNG (`png_for_upload`).
pub struct Prepared {
    pub bytes: Vec<u8>,
    pub svg: bool,
    /// The PNG's size; an SVG's is decided when it is rendered.
    pub size: Option<(u32, u32)>,
}

/// Read `path` for upload, recolouring an SVG by `colors` (`--layer-color-map`; a raster image
/// with a non-empty map is refused). Also returns the mapped colours the SVG has no layer of.
pub fn prepare(path: &Path, colors: &[(String, String)]) -> Result<(Prepared, Vec<String>), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    prepare_bytes(path, bytes, colors)
}

/// [`prepare`] for bytes already read (an SVG if `path` ends in `.svg`).
pub fn prepare_bytes(path: &Path, mut bytes: Vec<u8>, colors: &[(String, String)]) -> Result<(Prepared, Vec<String>), String> {
    if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("svg")) {
        let mut missing = Vec::new();
        if !colors.is_empty() {
            (bytes, missing) = recolor_layers(&bytes, colors).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        if bytes.len() > MAX_SVG_BYTES {
            return Err(format!("{}: {:.1} MB; the limit for SVG is {} MB", path.display(), bytes.len() as f64 / 1e6, MAX_SVG_BYTES / (1024 * 1024)));
        }
        return Ok((Prepared { bytes, svg: true, size: None }, missing));
    }
    if !colors.is_empty() {
        return Err(format!("{}: --layer-color-map recolours SVGs only", path.display()));
    }
    let (png, w, h) = png_for_upload(path, &bytes)?;
    Ok((Prepared { bytes: png, svg: false, size: Some((w, h)) }, Vec::new()))
}

/// Decode any supported raster image, downscale it to `MAX_IMAGE_SIDE` and encode it as PNG
/// (which also drops its metadata); fails above `MAX_PNG_BYTES`.
fn png_for_upload(path: &Path, bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut img = image::load_from_memory(bytes).map_err(|e| format!("{}: {e}", path.display()))?.to_rgba8();
    let (w, h) = img.dimensions();
    if w.max(h) > MAX_IMAGE_SIDE {
        let s = MAX_IMAGE_SIDE as f32 / w.max(h) as f32;
        img = image::imageops::resize(&img, ((w as f32 * s) as u32).max(1), ((h as f32 * s) as u32).max(1), image::imageops::FilterType::Lanczos3);
    }
    let (w, h) = img.dimensions();
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    if out.len() > MAX_PNG_BYTES {
        return Err(format!("{}: {:.1} MB as PNG; the limit is {} MB", path.display(), out.len() as f64 / 1e6, MAX_PNG_BYTES / (1024 * 1024)));
    }
    Ok((out, w, h))
}

/// A refusal from the Worker, with its HTTP status (429: the day's quota is used up).
pub struct Refused {
    pub status: u16,
    pub message: String,
}

/// Submit one asset, with the upload key if one is given; returns the submission id.
pub fn submit_asset(url: &str, meta: &Meta, file: &Prepared, key: Option<&str>) -> Result<String, Refused> {
    let refused = |message: String| Refused { status: 0, message };
    let meta = serde_json::to_string(meta).map_err(|e| refused(e.to_string()))?;
    let boundary = format!("biocartoon-{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    let mut body = Vec::new();
    for (name, value) in [("kind", "asset"), ("meta", meta.as_str())] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    let (name, filename, content_type) = if file.svg { ("svg", "image.svg", "image/svg+xml") } else { ("image", "image.png", "image/png") };
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(&file.bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(120))).http_status_as_error(false).build().into();
    let mut req = agent.post(&format!("{}/submit", url.trim_end_matches('/'))).header("Content-Type", &format!("multipart/form-data; boundary={boundary}"));
    if let Some(key) = key {
        req = req.header("X-Upload-Key", key);
    }
    let mut res = req
        .send(&body[..])
        .map_err(|e| refused(format!("couldn't reach the submission server: {e}")))?;
    let status = res.status().as_u16();
    let text = res.body_mut().with_config().limit(64 * 1024).read_to_string().unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    if (200..300).contains(&status) {
        return v["id"].as_str().map(str::to_string).ok_or_else(|| refused("the submission server sent an unexpected reply".into()));
    }
    let message = v["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("the submission server answered HTTP {status}"));
    Err(Refused { status, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_from_file_names() {
        assert_eq!(title_from_path(Path::new("x/t_cell-receptor.png")), "t cell receptor");
        assert_eq!(title_from_path(Path::new("Mitochondrion  2.JPG")), "Mitochondrion 2");
    }

    #[test]
    fn color_maps() {
        let map = parse_color_map(&["#FF0000:#0000ff, 00f:f00"]).unwrap();
        assert_eq!(map, [("#ff0000".into(), "#0000ff".into()), ("#0000ff".into(), "#ff0000".into())]);
        assert!(parse_color_map(&["red:#000"]).is_err());
        assert!(parse_color_map(&["#000"]).is_err());
        assert!(parse_color_map(&["#000:#111,#000000:#222"]).is_err());
        // Swapped at once, short forms and CSS included; ids and longer hex runs untouched.
        let svg = r##"<path fill="#F00" style="stroke:#0000ff"/><use href="#f00-x"/><rect fill="#ff00001"/>"##;
        let (out, missing) = recolor_svg(svg, &map);
        assert_eq!(out, r##"<path fill="#0000ff" style="stroke:#ff0000"/><use href="#f00-x"/><rect fill="#ff00001"/>"##);
        assert!(missing.is_empty());
    }

    #[test]
    fn meta_leaves_out_unsaid_fields() {
        let meta = Meta {
            title: "t".into(), description: String::new(), category: String::new(), tags: Vec::new(), author: "a".into(), license: "CC-BY-4.0".into(),
            generative_ai_used: None, generative_ai_details: String::new(), official: false, replaces: None, layers: Vec::new(),
        };
        let v = serde_json::to_value(&meta).unwrap();
        assert!(["generative_ai_used", "official", "replaces", "layers"].iter().all(|k| v.get(k).is_none()));
        let v = serde_json::to_value(Meta { replaces: Some("cell-0a1b2c3d4e".into()), ..meta.clone() }).unwrap();
        assert_eq!(v["replaces"], "cell-0a1b2c3d4e");
        let v = serde_json::to_value(Meta { generative_ai_used: Some(false), official: true, ..meta }).unwrap();
        assert_eq!((v["generative_ai_used"].as_bool(), v["official"].as_bool()), (Some(false), Some(true)));
    }

    #[test]
    fn upload_slugs() {
        assert_eq!(upload_slug("user/cell-0a1b2c3d4e"), Some("cell-0a1b2c3d4e"));
        assert_eq!(upload_slug("cell-0a1b2c3d4e"), Some("cell-0a1b2c3d4e"));
        assert_eq!(upload_slug("user/cell-0a1b2c3d4e.png"), Some("cell-0a1b2c3d4e"));
        assert_eq!(upload_slug("UG000123"), None);
        assert_eq!(upload_slug("ug000123"), None);
        assert_eq!(upload_slug("user/../x"), None);
        assert_eq!(upload_slug(""), None);
    }

    #[test]
    fn layers_kept_by_an_update() {
        let l = |n: &str, c: &[&str]| Layer { name: n.into(), colors: c.iter().map(|c| c.to_string()).collect() };
        let old = [l("Liquid", &["#f49dc0"]), l("Glass", &["#ffffff", "#cccccc"])];
        assert_eq!(kept_layers(&old, &["#f49dc0".into(), "#ffffff".into()]), [l("Liquid", &["#f49dc0"])]);
    }

    #[test]
    fn image_extensions() {
        assert!(is_image(Path::new("a.PNG")));
        assert!(is_image(Path::new("a.jpeg")));
        assert!(is_image(Path::new("a.SVG")));
        assert!(!is_image(Path::new("a.pdf")));
        assert!(!is_image(Path::new("README")));
    }

    #[test]
    fn svgs_are_sent_as_is() {
        let dir = std::env::temp_dir().join(format!("biocartoon-upload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cell.svg");
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#c33"/></svg>"##;
        std::fs::write(&path, svg).unwrap();
        let (p, _) = prepare(&path, &[]).unwrap();
        assert!(p.svg && p.size.is_none() && p.bytes == svg);
        let (p, missing) = prepare(&path, &parse_color_map(&["c33:#00AA00", "#123456:#000"]).unwrap()).unwrap();
        assert!(String::from_utf8(p.bytes).unwrap().contains(r##"fill="#00aa00""##));
        assert_eq!(missing, ["#123456"]);
        // Layers written as names, rgb() and CSS classes recolour too, as in the editor.
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10"><style>.c{fill:rgb(0,0,255)}</style>
            <g fill="white"><rect width="10" height="10"/></g><rect class="c" x="10" width="10" height="10"/><rect x="20" width="10" height="10" style="fill:#F00"/></svg>"##;
        std::fs::write(&path, svg).unwrap();
        let tree = parse_svg(svg).unwrap();
        let mut found = svg_colors(&tree);
        found.sort();
        assert_eq!(found, ["#0000ff", "#ff0000", "#ffffff"]);
        let (p, missing) = prepare(&path, &parse_color_map(&["fff:000", "#0000ff:#00ff00", "f00:fff"]).unwrap()).unwrap();
        let mut found = svg_colors(&parse_svg(&p.bytes).unwrap());
        found.sort();
        assert_eq!((found, missing), (vec!["#000000".to_string(), "#00ff00".into(), "#ffffff".into()], vec![]));
        std::fs::write(&path, vec![b' '; MAX_SVG_BYTES + 1]).unwrap();
        assert!(prepare(&path, &[]).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
