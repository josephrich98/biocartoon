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
/// Submissions the Worker accepts per address per rolling day.
pub const MAX_PER_DAY: usize = 20;
pub const LICENSES: [&str; 2] = ["CC0-1.0", "CC-BY-4.0"];

/// File extensions `upload` reads (what the `image` crate decodes here, and SVG).
const IMAGE_EXTENSIONS: [&str; 10] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "ico", "svg"];

/// The metadata the Worker expects in the `meta` field.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Meta {
    pub title: String,
    pub description: String,
    pub category: String,
    pub author: String,
    pub license: String,
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

pub fn prepare(path: &Path) -> Result<Prepared, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("svg")) {
        if bytes.len() > MAX_SVG_BYTES {
            return Err(format!("{}: {:.1} MB; the limit for SVG is {} MB", path.display(), bytes.len() as f64 / 1e6, MAX_SVG_BYTES / (1024 * 1024)));
        }
        return Ok(Prepared { bytes, svg: true, size: None });
    }
    let (png, w, h) = png_for_upload(path, &bytes)?;
    Ok(Prepared { bytes: png, svg: false, size: Some((w, h)) })
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

/// Submit one asset; returns the submission id.
pub fn submit_asset(url: &str, meta: &Meta, file: &Prepared) -> Result<String, Refused> {
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
    let mut res = agent
        .post(&format!("{}/submit", url.trim_end_matches('/')))
        .header("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
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
        let p = prepare(&path).unwrap();
        assert!(p.svg && p.size.is_none() && p.bytes == svg);
        std::fs::write(&path, vec![b' '; MAX_SVG_BYTES + 1]).unwrap();
        assert!(prepare(&path).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
