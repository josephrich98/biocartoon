//! The published slide templates (desktop only): the ones users shared from the editor and a
//! reviewer approved, listed in `<asset URL>/catalog/templates.sqlite.gz` by
//! `data/publish_catalog.py`. Each is a slide-layout JSON at `json_url` with a thumbnail at
//! `thumb_url`; only the BioCartoon editor opens them. The editor keeps its own list (with its
//! built-in layouts and the user's templates); this is the shared library alone, cached in
//! `<data dir>/biocartoon/catalog/templates.sqlite`.

use crate::query::{app_dir, asset_base_url, fetch_url};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

const DB_FILE: &str = "templates.sqlite";
const VERSION_FILE: &str = "templates_version.txt";

#[derive(Clone, Debug, Serialize)]
pub struct PublishedTemplate {
    pub id: String,
    pub title: String,
    pub description: String,
    pub category: String,
    pub author: String,
    pub license: String,
    pub created_at: String,
    /// The template's slide JSON (the editor's `TemplateFile`).
    pub json_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb_url: Option<String>,
}

/// Brings the cached list up to date with the published one (a no-op when the version matches)
/// and returns its path. Offline, a cached copy is used as it is.
pub fn ensure_templates() -> Result<PathBuf, String> {
    let dir = app_dir().join("catalog");
    let db = dir.join(DB_FILE);
    match sync(&asset_base_url(), &dir) {
        Ok(()) => Ok(db),
        Err(e) if db.exists() => {
            log::warn!("templates not refreshed: {e}");
            Ok(db)
        }
        Err(e) => Err(e),
    }
}

fn sync(base: &str, dir: &Path) -> Result<(), String> {
    let base = base.trim_end_matches('/');
    let version = String::from_utf8_lossy(&fetch_url(&format!("{base}/catalog/{VERSION_FILE}"))?).trim().to_string();
    if version.is_empty() {
        return Err("templates version is empty".into());
    }
    let db = dir.join(DB_FILE);
    if db.exists() && std::fs::read_to_string(dir.join(VERSION_FILE)).is_ok_and(|v| v.trim() == version) {
        return Ok(());
    }
    let gz = fetch_url(&format!("{base}/catalog/{DB_FILE}.gz"))?;
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(gz.as_slice()).read_to_end(&mut bytes).map_err(|e| format!("templates download: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = dir.join(format!("{DB_FILE}.part"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &db).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(VERSION_FILE), &version).map_err(|e| e.to_string())
}

/// Every template in the list at `path`, newest first. `query` filters by words in the title,
/// description or category (all must appear), as the editor's template search does.
pub fn search(path: &Path, query: &str) -> Result<Vec<PublishedTemplate>, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| format!("open {}: {e}", path.display()))?;
    let base = asset_base_url();
    let url = |key: &str| format!("{}/{}", base.trim_end_matches('/'), key);
    let mut st = conn
        .prepare(
            "SELECT id, title, coalesce(description,''), coalesce(category,''), coalesce(author,''), coalesce(license,''), \
             coalesce(created_at,''), json_key, coalesce(thumb_key,'') FROM templates ORDER BY created_at DESC, title",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            let thumb: String = r.get(8)?;
            Ok(PublishedTemplate {
                id: r.get(0)?,
                title: r.get(1)?,
                description: r.get(2)?,
                category: r.get(3)?,
                author: r.get(4)?,
                license: r.get(5)?,
                created_at: r.get(6)?,
                json_url: url(&r.get::<_, String>(7)?),
                thumb_url: (!thumb.is_empty()).then(|| url(&thumb)),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<PublishedTemplate> = rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    let terms: Vec<String> = crate::catalog::Worker::query_words(query).into_iter().filter(|t| t.chars().count() >= 2).collect();
    if !terms.is_empty() {
        out.retain(|t| {
            let hay = format!("{} {} {}", t.title, t.description, t.category).to_lowercase();
            terms.iter().all(|w| hay.contains(w.as_str()))
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searches_by_all_words() {
        let dir = std::env::temp_dir().join(format!("biocartoon-templates-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(DB_FILE);
        let _ = std::fs::remove_file(&path);
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE templates (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, category TEXT, author TEXT, \
             license TEXT, created_at TEXT, json_key TEXT NOT NULL, thumb_key TEXT, json_local TEXT, thumb_local TEXT);
             INSERT INTO templates VALUES ('a', 'Cell signaling', 'A receptor pathway', 'Biology', 'x', 'CC-BY-4.0', '2026-01-02', 'templates/a/template.json', 'templates/a/thumb.png', NULL, NULL);
             INSERT INTO templates VALUES ('b', 'Lab workflow', 'Bench steps', 'Methods', 'y', 'CC0-1.0', '2026-01-01', 'templates/b/template.json', '', NULL, NULL);",
        )
        .unwrap();
        drop(c);
        assert_eq!(search(&path, "").unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        let hits = search(&path, "receptor biology").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].json_url.ends_with("/templates/a/template.json"));
        assert!(hits[0].thumb_url.as_deref().unwrap().ends_with("/templates/a/thumb.png"));
        assert!(search(&path, "workflow").unwrap()[0].thumb_url.is_none());
        assert!(search(&path, "receptor methods").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
