//! Synchronous catalog access for the command line and the MCP server, and for programs that
//! want the catalog without the editor (desktop only).
//!
//! Searching goes through the same [`crate::catalog::Worker`] the BioCartoon editor uses, so the
//! ranking is identical; this module adds the columns the editor doesn't show (description, tags,
//! links), a note of which fields the query matched, and read-only SQL. The catalog is the copy in
//! `<data dir>/biocartoon/catalog/` that the editor shares (`BIOCARTOON_DB` overrides it), and is
//! downloaded when it is missing.

use crate::catalog::{cached_catalog, sync_catalog, AssetRow, CategoryInfo, Facets, Filter, IconSort, SourceInfo, TaxonCount, Worker};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The data folder shared with the BioCartoon editor (`~/Library/Application Support/biocartoon`
/// on macOS): the downloaded catalog and the usage file live here.
pub fn app_dir() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("biocartoon")
}

/// Where asset PNGs and the catalog are served from (`BIOCARTOON_ASSET_URL` overrides).
pub fn asset_base_url() -> String {
    std::env::var("BIOCARTOON_ASSET_URL").unwrap_or_else(|_| crate::DEFAULT_ASSET_URL.into())
}

/// The catalog file to open: `BIOCARTOON_DB`, else the copy the editor downloaded.
pub fn catalog_path() -> Option<PathBuf> {
    match std::env::var("BIOCARTOON_DB") {
        Ok(p) if !p.is_empty() => Some(PathBuf::from(p)),
        _ => cached_catalog(&app_dir().join("catalog")),
    }
}

/// The catalog path, downloading the published catalog first when there is no copy yet (or
/// when `refresh` is set). `progress` is called with the bytes downloaded so far.
pub fn ensure_catalog(refresh: bool, progress: impl Fn(u64)) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("BIOCARTOON_DB") {
        if !p.is_empty() {
            let p = PathBuf::from(p);
            return if p.exists() { Ok(p) } else { Err(format!("BIOCARTOON_DB: {} does not exist", p.display())) };
        }
    }
    let dir = app_dir().join("catalog");
    if !refresh {
        if let Some(p) = cached_catalog(&dir) {
            return Ok(p);
        }
    }
    let base = asset_base_url();
    let bytes = Arc::new(AtomicU64::new(0));
    let (tx, rx) = std::sync::mpsc::channel();
    let (b, d) = (bytes.clone(), dir.clone());
    std::thread::spawn(move || {
        let _ = tx.send(sync_catalog(&base, &d, &b));
    });
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(Some(p))) => return Ok(p),
            Ok(Ok(None)) => return cached_catalog(&dir).ok_or_else(|| "catalog is current but missing".to_string()),
            Ok(Err(e)) => return Err(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => progress(bytes.load(Ordering::Relaxed)),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err("catalog download stopped".into()),
        }
    }
}

/// One catalog row, with everything a caller might want to judge or place it.
#[derive(Clone, Debug, Serialize)]
pub struct Asset {
    pub id: String,
    pub source: String,
    pub source_name: String,
    pub title: String,
    pub variant: String,
    pub category: String,
    pub description: String,
    pub tags: Vec<String>,
    pub license: String,
    pub credit: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    pub png_key: String,
    /// Where the PNG can be fetched (a URL, or a local path for user-generated assets).
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub svg_key: Option<String>,
    /// Where the SVG can be fetched, when there is one (Servier publishes PNGs only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub svg_url: Option<String>,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub png_local: Option<String>,
    /// Stars from app users (the catalog's snapshot, or the latest count this computer saw).
    pub stars: i64,
    /// Starred from this computer's app.
    pub starred: bool,
    /// Which fields the search terms matched, strongest first (title, tags, category,
    /// description). Empty when the result came from browsing rather than a query.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub matched_fields: Vec<String>,
    /// Search terms found in none of the fields: the result matched a typo-corrected or mid-word
    /// spelling of them, or (when no asset has every word) only some of the words.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub missing_terms: Vec<String>,
}

impl Asset {
    pub fn to_row(&self) -> AssetRow {
        AssetRow {
            id: self.id.clone(),
            source: self.source.clone(),
            source_name: self.source_name.clone(),
            title: self.title.clone(),
            variant: self.variant.clone(),
            category: self.category.clone(),
            description: self.description.clone(),
            tags: self.tags.clone(),
            license: self.license.clone(),
            credit: self.credit.clone(),
            author: self.author.clone(),
            png_key: self.png_key.clone(),
            png_local: self.png_local.clone(),
            png_width: self.width,
            png_height: self.height,
            svg_key: self.svg_key.clone(),
            stars: self.stars,
            starred: self.starred,
            taxa: crate::taxonomy::classify(&self.source, &self.category, &self.title, &self.tags.join(" ")),
            layers: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SqlResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// True when more rows matched than were returned.
    pub truncated: bool,
}

pub struct Catalog {
    worker: Worker,
    /// A second, read-only connection for ad-hoc SQL (it can't touch the catalog).
    ro: Connection,
    pub path: PathBuf,
    pub base_url: String,
}

const DETAIL_COLS: &str = "a.id, a.source, a.source_name, coalesce(a.title,''), coalesce(a.variant,''), coalesce(a.category,''), \
    coalesce(a.description,''), coalesce(a.tags,'[]'), a.license, a.credit, coalesce(a.author,''), a.source_url, a.png_key, \
    a.png_local, coalesce(a.png_width,0), coalesce(a.png_height,0)";

/// Longest SQL query the `sql` command may run before it is interrupted.
const SQL_TIMEOUT: Duration = Duration::from_secs(10);

impl Catalog {
    pub fn open(path: &Path) -> Result<Self, String> {
        let usage = app_dir().join("usage.sqlite");
        let usage = if usage.exists() { usage } else { PathBuf::new() };
        let worker = Worker::open_readonly(path, &usage)?;
        let ro = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        ro.pragma_update(None, "query_only", true).map_err(|e| e.to_string())?;
        Ok(Self { worker, ro, path: path.to_path_buf(), base_url: asset_base_url() })
    }

    /// Open the configured catalog, downloading it first if there is none.
    pub fn open_default() -> Result<Self, String> {
        let path = ensure_catalog(false, |b| eprintln!("downloading the icon catalog... {:.1} MB", b as f64 / 1e6))?;
        Self::open(&path)
    }

    fn url_for(&self, png_key: &str, png_local: Option<&str>) -> String {
        match png_local.filter(|p| Path::new(p).exists()) {
            Some(p) => p.to_string(),
            None => format!("{}/{}", self.base_url.trim_end_matches('/'), png_key),
        }
    }

    fn asset_from(&self, r: &rusqlite::Row) -> rusqlite::Result<Asset> {
        let tags: String = r.get(7)?;
        let png_key: String = r.get(12)?;
        let png_local: Option<String> = r.get(13)?;
        let (svg_key, svg_local): (Option<String>, Option<String>) = (r.get(18)?, r.get(19)?);
        Ok(Asset {
            id: r.get(0)?,
            source: r.get(1)?,
            source_name: r.get(2)?,
            title: r.get(3)?,
            variant: r.get(4)?,
            category: r.get(5)?,
            description: r.get(6)?,
            tags: serde_json::from_str::<Vec<String>>(&tags).unwrap_or_default(),
            license: r.get(8)?,
            credit: r.get(9)?,
            author: r.get(10)?,
            source_url: r.get(11)?,
            url: self.url_for(&png_key, png_local.as_deref()),
            svg_url: svg_key.as_deref().map(|k| self.url_for(k, svg_local.as_deref())),
            svg_key,
            png_key,
            width: r.get::<_, i64>(14)? as u32,
            height: r.get::<_, i64>(15)? as u32,
            png_local,
            stars: r.get(16)?,
            starred: r.get::<_, i64>(17)? != 0,
            matched_fields: Vec::new(),
            missing_terms: Vec::new(),
        })
    }

    /// Full rows for `ids`, in the same order.
    fn details<'a>(&self, ids: impl IntoIterator<Item = &'a str>) -> Result<Vec<Asset>, String> {
        let sql = format!(
            "SELECT {DETAIL_COLS}, {}, a.svg_key, a.svg_local FROM assets a {} WHERE a.id = ?1",
            self.worker.stars_cols(),
            self.worker.stars_join()
        );
        let mut st = self.worker.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(a) = st.query_row(params![id], |r| self.asset_from(r)).ok() {
                out.push(a);
            }
        }
        Ok(out)
    }

    /// The editor's search: the best `limit` matches (one per icon, science collections first),
    /// in `sort` order. Always returns something for a non-empty query that matches anything;
    /// `matched_fields` on each result says how good the match is.
    pub fn search(&self, query: &str, sources: &[String], limit: usize, sort: IconSort) -> Result<Vec<Asset>, String> {
        self.search_in(query, sources, None, limit, sort)
    }

    /// [`Self::search`] within one category of [`crate::taxonomy`] (see
    /// [`crate::catalog::Worker::search_in`]).
    pub fn search_in(&self, query: &str, sources: &[String], taxon: Option<(&str, &str)>, limit: usize, sort: IconSort) -> Result<Vec<Asset>, String> {
        let rows = self.worker.search_in(query, sources, taxon, limit, sort).map_err(|e| e.to_string())?;
        let mut out = self.details(rows.iter().map(|r| r.id.as_str()))?;
        for a in &mut out {
            annotate(a, query);
        }
        Ok(out)
    }

    /// The icons matching `query` that pass `filter` (every icon passing it when `query` is
    /// empty), `offset` and `limit` paging through them in `sort` order, with how many there are.
    /// Each of `filter`'s lists keeps the icons matching any of its entries, and an icon has to
    /// pass every list.
    pub fn search_filtered(&self, query: &str, filter: &Filter, offset: usize, limit: usize, sort: IconSort) -> Result<(Vec<Asset>, i64), String> {
        let rows = self.worker.search_filtered(query, filter, offset, limit, sort).map_err(|e| e.to_string())?;
        let total = self.worker.search_filtered_total(query, filter).map_err(|e| e.to_string())?;
        let mut out = self.details(rows.iter().map(|r| r.id.as_str()))?;
        for a in &mut out {
            annotate(a, query);
        }
        Ok((out, total))
    }

    /// Icon counts of each value `filter`'s lists could take (licenses, databases' own
    /// categories, file types, ...), under the rest of `filter`, of the icons `query` finds ("" for all).
    pub fn facets(&self, query: &str, filter: &Filter) -> Result<Facets, String> {
        self.worker.facets(query, filter).map_err(|e| e.to_string())
    }

    pub fn get(&self, id: &str) -> Result<Option<Asset>, String> {
        Ok(self.details([id])?.pop())
    }

    /// Colour / style variants of the same asset (see `Worker::variants`), the given one included.
    pub fn variants(&self, id: &str) -> Result<Vec<Asset>, String> {
        let rows = self.worker.variants(id).map_err(|e| e.to_string())?;
        self.details(rows.iter().map(|r| r.id.as_str()))
    }

    pub fn browse(&self, source: &str, category: Option<&str>, offset: usize, limit: usize, sort: IconSort) -> Result<Vec<Asset>, String> {
        let rows = self.worker.browse(source, category, offset, limit, sort).map_err(|e| e.to_string())?;
        self.details(rows.iter().map(|r| r.id.as_str()))
    }

    /// Page through one category of [`crate::taxonomy`] (everything when `taxon` is `None`),
    /// with the number of titles there are.
    pub fn browse_taxon(
        &self,
        taxon: Option<(&str, &str)>,
        sources: &[String],
        offset: usize,
        limit: usize,
        sort: IconSort,
    ) -> Result<(Vec<Asset>, i64), String> {
        let (cat, sub) = taxon.unzip();
        let (rows, total) = self.worker.browse_taxon(cat, sub, sources, offset, limit, sort).map_err(|e| e.to_string())?;
        Ok((self.details(rows.iter().map(|r| r.id.as_str()))?, total))
    }

    /// Title counts of every category and subcategory, under `sources`.
    pub fn taxonomy(&self, sources: &[String]) -> Result<Vec<TaxonCount>, String> {
        self.worker.taxonomy(sources).map_err(|e| e.to_string())
    }

    /// How many titles a source holds ([`crate::catalog::BIOCARTOON_SOURCE`] included).
    pub fn source_total(&self, source: &str) -> Result<i64, String> {
        self.worker.search_total("", &[source.to_string()]).map_err(|e| e.to_string())
    }

    pub fn sources(&self) -> Result<Vec<SourceInfo>, String> {
        self.worker.sources().map_err(|e| e.to_string())
    }

    pub fn categories(&self, source: &str) -> Result<Vec<CategoryInfo>, String> {
        self.worker.categories(source).map_err(|e| e.to_string())
    }

    /// Run one read-only SQL statement against the catalog, returning at most `max_rows` rows.
    pub fn sql(&self, sql: &str, max_rows: usize) -> Result<SqlResult, String> {
        // A watchdog interrupts the statement if it runs too long (no `hooks` feature needed).
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handle = self.ro.get_interrupt_handle();
        let (d, start) = (done.clone(), Instant::now());
        std::thread::spawn(move || {
            while !d.load(Ordering::Relaxed) {
                if start.elapsed() > SQL_TIMEOUT {
                    handle.interrupt();
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let res = self.sql_inner(sql, max_rows);
        done.store(true, Ordering::Relaxed);
        res
    }

    fn sql_inner(&self, sql: &str, max_rows: usize) -> Result<SqlResult, String> {
        let mut st = self.ro.prepare(sql).map_err(|e| e.to_string())?;
        if !st.readonly() {
            return Err("only read-only statements are allowed (SELECT, WITH, EXPLAIN, PRAGMA)".into());
        }
        let columns: Vec<String> = st.column_names().iter().map(|c| c.to_string()).collect();
        let n = columns.len();
        let mut rows = Vec::new();
        let mut truncated = false;
        let mut q = st.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = q.next().map_err(|e| {
            if e.to_string().contains("interrupted") { format!("query took longer than {} s and was stopped", SQL_TIMEOUT.as_secs()) } else { e.to_string() }
        })? {
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
            let mut row = Vec::with_capacity(n);
            for i in 0..n {
                row.push(match r.get_ref(i).map_err(|e| e.to_string())? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                    ValueRef::Blob(b) => Value::String(format!("<blob {} bytes>", b.len())),
                });
            }
            rows.push(row);
        }
        Ok(SqlResult { columns, rows, truncated })
    }

    /// The `CREATE` statements of every table and index, with notes on how to search.
    pub fn schema(&self) -> Result<String, String> {
        let mut st = self
            .ro
            .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'assets_fts_%' ORDER BY type DESC, name")
            .map_err(|e| e.to_string())?;
        let mut out: Vec<String> = st
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|s| format!("{s};"))
            .collect();
        out.push(
            "-- assets.tags is a JSON array of strings (use json_each). assets.png_key is the PNG's path under the\n\
             -- asset URL; the editor never shows rows with png_key NULL. Full-text search: \n\
             --   SELECT a.* FROM assets_fts f JOIN assets a ON a.rowid = f.rowid WHERE assets_fts MATCH 'neuron*' ORDER BY f.rank\n\
             -- (bm25 weights: title 10, description 1, tags 3, category 1, variant 0.5; lower rank is better).\n\
             -- Variants of one asset share (source, title) and differ in `variant` (colour scheme / style)."
                .to_string(),
        );
        Ok(out.join("\n"))
    }

    /// The PNG bytes of an asset (local file when there is one, otherwise fetched).
    pub fn fetch_png(&self, a: &Asset) -> Result<Vec<u8>, String> {
        match a.png_local.as_deref().map(PathBuf::from).filter(|p| p.exists()) {
            Some(p) => std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display())),
            None => fetch_url(&self.url_for(&a.png_key, None)),
        }
    }

    /// The SVG bytes of an asset; an error when it has none.
    pub fn fetch_svg(&self, a: &Asset) -> Result<Vec<u8>, String> {
        let url = a.svg_url.as_deref().ok_or_else(|| format!("{} has no SVG ({} publishes PNGs only)", a.id, a.source_name))?;
        match Path::new(url).exists() {
            true => std::fs::read(url).map_err(|e| format!("{url}: {e}")),
            false => fetch_url(url),
        }
    }
}

/// Query terms the way the FTS query sees them (alphanumeric, at least two characters).
fn terms(query: &str) -> Vec<String> {
    Worker::query_words(query).into_iter().filter(|t| t.chars().count() >= 2).collect()
}

/// Fill in `matched_fields` / `missing_terms`: a term matches a field when it is a prefix of
/// one of the field's words, or that word plus a short ending (roughly what the stemmed FTS
/// prefix query does).
fn annotate(a: &mut Asset, query: &str) {
    let terms = terms(query);
    if terms.is_empty() {
        return;
    }
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.to_lowercase()).collect()
    };
    let fields: [(&str, Vec<String>); 4] = [
        ("title", words(&a.title)),
        ("tags", a.tags.iter().flat_map(|t| words(t)).collect()),
        ("category", words(&a.category)),
        ("description", words(&a.description)),
    ];
    // A prefix, or the word plus a plural / -ed / -ing ending the index's stemmer drops.
    let hit = |field: &[String], t: &str| {
        field.iter().any(|w| w.starts_with(t) || (w.len() >= 3 && t.starts_with(w.as_str()) && t.len() - w.len() <= 3))
    };
    a.matched_fields = fields.iter().filter(|(_, ws)| terms.iter().any(|t| hit(ws, t))).map(|(n, _)| n.to_string()).collect();
    a.missing_terms = terms.iter().filter(|t| !fields.iter().any(|(_, ws)| hit(ws, t))).cloned().collect();
}

/// GET `url` (at most 64 MB).
pub fn fetch_url(url: &str) -> Result<Vec<u8>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).build().into();
    let mut res = agent.get(url).call().map_err(|e| format!("GET {url}: {e}"))?;
    res.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec().map_err(|e| format!("read {url}: {e}"))
}

/// Re-encode a PNG with its longest side at most `max_side` px (e.g. for a smaller download).
pub fn shrink_png(bytes: &[u8], max_side: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = img.dimensions();
    let m = w.max(h);
    let img = if m > max_side && max_side > 0 {
        let s = max_side as f32 / m as f32;
        image::imageops::resize(&img, ((w as f32 * s) as u32).max(1), ((h as f32 * s) as u32).max(1), image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let (w, h) = img.dimensions();
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok((out, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset() -> Asset {
        Asset {
            id: "bioart/1".into(),
            source: "bioart".into(),
            source_name: "BioArt".into(),
            title: "Pyramidal Neuron".into(),
            variant: "blue".into(),
            category: "Cells and Organelles".into(),
            description: "A pyramidal neuron cell from the cortex".into(),
            tags: vec!["brain".into(), "cell".into()],
            license: "PD".into(),
            credit: String::new(),
            author: String::new(),
            source_url: None,
            png_key: "bioart/1.png".into(),
            url: String::new(),
            svg_key: None,
            svg_url: None,
            width: 10,
            height: 10,
            png_local: None,
            stars: 0,
            starred: false,
            matched_fields: Vec::new(),
            missing_terms: Vec::new(),
        }
    }

    #[test]
    fn annotates_matches_by_field() {
        let mut a = asset();
        annotate(&mut a, "neuron brain");
        assert_eq!(a.matched_fields, vec!["title", "tags", "description"]);
        assert!(a.missing_terms.is_empty());
        let mut a = asset();
        annotate(&mut a, "cortex mitochondria");
        assert_eq!(a.matched_fields, vec!["description"]);
        assert_eq!(a.missing_terms, vec!["mitochondria"]);
        let mut a = asset();
        annotate(&mut a, "neurons");
        assert_eq!(a.matched_fields, vec!["title", "description"]);
        annotate(&mut a, "T cell");
        assert_eq!(a.matched_fields, vec!["tags", "category", "description"]);
    }

    #[test]
    fn sql_is_read_only_and_capped() {
        let dir = std::env::temp_dir().join(format!("cc-query-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("assets.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, title TEXT, variant TEXT, \
             description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, source_url TEXT, png_key TEXT, \
             png_local TEXT, png_width INTEGER, png_height INTEGER, svg_key TEXT, svg_local TEXT); \
             INSERT INTO assets VALUES ('a/1','a','A','Neuron','','','cells','[\"brain\"]','PD','','',NULL,'a/1.png',NULL,1,1,'a/1.svg',NULL); \
             INSERT INTO assets VALUES ('a/2','a','A','Astrocyte','','','cells','[]','PD','','',NULL,'a/2.png',NULL,1,1,NULL,NULL);",
        )
        .unwrap();
        drop(c);
        let cat = Catalog::open(&db).unwrap();
        let r = cat.sql("SELECT id, title FROM assets ORDER BY id", 1).unwrap();
        assert_eq!(r.columns, vec!["id", "title"]);
        assert_eq!(r.rows, vec![vec![json!("a/1"), json!("Neuron")]]);
        assert!(r.truncated);
        assert!(cat.sql("DELETE FROM assets", 10).is_err());
        assert!(cat.sql("CREATE TABLE x (y)", 10).is_err());
        let hits = cat.search("neuron", &[], 10, IconSort::Alphabetical).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matched_fields, vec!["title"]);
        assert_eq!(cat.variants("a/1").unwrap().len(), 1);
        assert!(cat.schema().unwrap().contains("CREATE TABLE assets"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
