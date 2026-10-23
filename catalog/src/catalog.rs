//! The asset catalog: a SQLite file published to R2 by `data/publish_catalog.py` (or any
//! `assets.sqlite` built by `data/build_assets_db.py`), and the search over it.
//!
//! [`Worker`] runs every query the BioCartoon editor and the command line make, so the ranking is
//! the same everywhere. It also keeps a small per-install "usage" file next to the catalog (how
//! often each asset was placed, and star counts), which survives catalog updates.
//! [`sync_catalog`] downloads the published catalog (desktop only).

#[cfg(not(target_arch = "wasm32"))]
use rusqlite::OpenFlags;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;


#[derive(Clone, Debug, PartialEq)]
pub struct AssetRow {
    pub id: String,
    pub source: String,
    pub source_name: String,
    pub title: String,
    pub variant: String,
    pub category: String,
    /// The artist's or uploader's description (often empty).
    pub description: String,
    pub license: String,
    pub credit: String,
    pub author: String,
    pub png_key: String,
    pub png_local: Option<String>,
    pub png_width: u32,
    pub png_height: u32,
    /// The same image as an SVG, when the source publishes one (Servier publishes PNGs only).
    pub svg_key: Option<String>,
    /// Stars from everyone (the catalog's snapshot, or the latest count the Worker reported).
    pub stars: i64,
    /// Whether this install starred it (kept in the usage file, see [`Worker::set_stars`]).
    pub starred: bool,
    /// Its places in `crate::taxonomy`: (category, subcategory), at least one for a catalog row.
    pub taxa: Vec<crate::taxonomy::Taxon>,
}

/// The latest star count of one asset, and whether this install's own star is among them.
#[derive(Clone, Debug, PartialEq)]
pub struct StarUpdate {
    pub id: String,
    pub n: i64,
    pub mine: bool,
}

#[derive(Clone, Debug)]
pub struct SourceInfo {
    pub source: String,
    pub name: String,
    /// Images, colour variants included.
    pub count: i64,
    /// Distinct icons (colour variants counted once), as browsing and search list them.
    pub icons: i64,
    pub licenses: String,
}

/// Icons in one of BioCartoon's own categories (see `crate::taxonomy`), under the current
/// database filter. `sub` is empty for the whole category; both are empty for everything.
#[derive(Clone, Debug)]
pub struct TaxonCount {
    pub cat: String,
    pub sub: String,
    pub count: i64,
}

#[derive(Clone, Debug)]
pub struct CategoryInfo {
    pub name: String,
    pub count: i64,
}

/// Display order of asset results.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
pub enum IconSort {
    #[default]
    Alphabetical,
    ReverseAlphabetical,
    /// Most placed on a canvas first (counted locally, see `Req::RecordUse`).
    Popular,
    /// Best match first (search only; browsing and empty queries fall back to A to Z).
    Relevance,
}

impl IconSort {
    /// Orders offered when browsing a database.
    pub const ALL: [IconSort; 3] = [IconSort::Alphabetical, IconSort::ReverseAlphabetical, IconSort::Popular];
    /// Orders offered for search results.
    pub const SEARCH: [IconSort; 4] = [IconSort::Relevance, IconSort::Alphabetical, IconSort::ReverseAlphabetical, IconSort::Popular];

    pub fn label(self) -> &'static str {
        match self {
            IconSort::Alphabetical => "A to Z",
            IconSort::ReverseAlphabetical => "Z to A",
            IconSort::Popular => "Popular",
            IconSort::Relevance => "Relevance",
        }
    }

    /// ORDER BY terms over `assets a` joined with `usage.uses us` (and, for search, the picked
    /// set `m` with its `score`). Ends in `a.id` so ties are stable.
    fn sql(self) -> String {
        match self {
            IconSort::Alphabetical => "lower(coalesce(a.title,'')), a.title, a.id".into(),
            IconSort::ReverseAlphabetical => "lower(coalesce(a.title,'')) DESC, a.title DESC, a.id DESC".into(),
            IconSort::Popular => "coalesce(us.n,0) DESC, lower(coalesce(a.title,'')), a.title, a.id".into(),
            IconSort::Relevance => "m.score, a.id".into(),
        }
    }

    /// The order to use where there is no match score.
    fn without_score(self) -> IconSort {
        if self == IconSort::Relevance { IconSort::Alphabetical } else { self }
    }
}

const USES_JOIN: &str = "LEFT JOIN usage.uses us ON us.source = a.source AND us.title = coalesce(a.title,'')";
/// Stand-in for [`USES_JOIN`] when `usage.uses` doesn't exist: every asset has no uses.
const NO_USES_JOIN: &str = "LEFT JOIN (SELECT NULL AS source, NULL AS title, NULL AS n) us ON 0";

/// Pseudo-source for BioCartoon's own icons: uploads (source `user`) whose author is BioCartoon.
pub const BIOCARTOON_SOURCE: &str = "biocartoon";
pub const BIOCARTOON_AUTHOR: &str = "BioCartoon";

/// Every asset database: (source, badge code, name, what it holds), in [`SOURCE_ORDER`].
pub const SOURCES: &[(&str, &str, &str, &str)] = &[
    (BIOCARTOON_SOURCE, "BC", "BioCartoon", "BioCartoon's own icons, drawn for the editor"),
    ("bioart", "BA", "NIAID NIH BioArt", "NIH's public-domain biomedical illustrations: cells, pathogens, lab equipment, anatomy"),
    ("bioicons", "BI", "Bioicons", "Community-made icons for life-science figures, mostly CC0 / CC-BY"),
    ("servier", "SV", "Servier Medical Art", "Detailed medical and anatomical drawings (CC-BY 4.0; PNG only)"),
    ("scidraw", "SD", "SciDraw", "Neuroscience and model-organism drawings from the community"),
    ("healthicons", "HI", "Health Icons", "Clinical and public-health pictograms in outline and filled styles"),
    ("reactome", "RE", "Reactome Icon Library", "Molecules, cells and organelles for pathway diagrams"),
    ("openmoji", "OM", "OpenMoji", "Open-source emoji: generic everyday pictograms"),
    ("user", "UG", "User-generated", "Icons people uploaded from the editor"),
];

/// The source a command-line name stands for: its key (`bioart`) or badge code (`BA`), any case.
pub fn resolve_source(s: &str) -> Option<&'static str> {
    SOURCES.iter().find(|(k, c, _, _)| k.eq_ignore_ascii_case(s) || c.eq_ignore_ascii_case(s)).map(|(k, ..)| *k)
}

/// The database an asset is listed under: [`BIOCARTOON_SOURCE`] for the uploads (source `user`)
/// whose author is [`BIOCARTOON_AUTHOR`], which a reviewer approved as BioCartoon's own; its
/// source otherwise. As biocartoon-app's `theme::asset_source`.
const SHOWN_SOURCE: &str = "CASE WHEN a.source = 'user' AND a.author = 'BioCartoon' THEN 'biocartoon' ELSE a.source END";

/// The `source` column of a database's assets (`user` for BioCartoon's own).
fn stored_source(source: &str) -> &str {
    if source == BIOCARTOON_SOURCE { "user" } else { source }
}

/// The condition that an asset is listed under the database `?1`. Matching `a.source` too lets
/// SQLite use its index.
fn source_is() -> String {
    format!("a.source = CASE ?1 WHEN '{BIOCARTOON_SOURCE}' THEN 'user' ELSE ?1 END AND ({SHOWN_SOURCE}) = ?1")
}

/// ` AND (...)` keeping the assets listed under these databases (see [`SHOWN_SOURCE`]), or nothing
/// for every database.
fn src_filter(sources: &[String]) -> String {
    if sources.is_empty() {
        return String::new();
    }
    let list = |v: Vec<&str>| v.iter().map(|s| format!("'{}'", s.replace('\'', "''"))).collect::<Vec<_>>().join(",");
    let stored = list(sources.iter().map(|s| stored_source(s)).collect());
    format!(" AND (a.source IN ({stored}) AND ({SHOWN_SOURCE}) IN ({}))", list(sources.iter().map(String::as_str).collect()))
}

/// What a search keeps besides its words. Each list keeps the assets matching any of its entries
/// (an empty one keeps everything), and an asset has to pass every list.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Filter {
    /// Databases, as [`SHOWN_SOURCE`] names them.
    pub sources: Vec<String>,
    /// Parts of the author's name, any case ("ann" finds Ann Smith).
    pub authors: Vec<String>,
    /// Licenses as stored ("CC-BY-4.0").
    pub licenses: Vec<String>,
    /// Places in `crate::taxonomy`: (category, subcategory), the subcategory "" for all of it.
    pub taxa: Vec<(String, String)>,
    /// A database's own categories: (database as [`SHOWN_SOURCE`] names it, category). An asset
    /// filed under several (", "-separated) is in each.
    pub db_cats: Vec<(String, String)>,
    /// File types, [`FORMAT_SVG`] (the source publishes an SVG) or [`FORMAT_PNG`] (a PNG only).
    pub formats: Vec<String>,
}

pub const FORMAT_SVG: &str = "SVG";
pub const FORMAT_PNG: &str = "PNG";

/// Icon counts of a filter's choices (see [`Worker::facets`]); only those with icons are listed.
#[derive(Clone, Debug, Default)]
pub struct Facets {
    /// By database, as [`SHOWN_SOURCE`] names them.
    pub sources: Vec<(String, i64)>,
    pub licenses: Vec<(String, i64)>,
    pub taxa: Vec<TaxonCount>,
    /// (database, its own category, icons), by database then category.
    pub db_cats: Vec<(String, String, i64)>,
    /// By file type, [`FORMAT_SVG`] or [`FORMAT_PNG`].
    pub formats: Vec<(String, i64)>,
}

impl Filter {
    pub fn sources(sources: &[String]) -> Self {
        Self { sources: sources.to_vec(), ..Self::default() }
    }
}

/// The category term of a browse (`?2`): one of the ", "-separated categories an asset is filed
/// under ("" for uncategorized), or anything when `None`.
fn category_filter(category: Option<&str>) -> (&'static str, String) {
    match category {
        Some(c) => (
            " AND (coalesce(a.category,'') = ?2 OR (?2 <> '' AND instr(', ' || a.category || ', ', ', ' || ?2 || ', ') > 0))",
            c.to_string(),
        ),
        None => (" AND ?2 = ?2", String::new()),
    }
}

/// Ordering of the source list: user uploads, then the science collections. Results don't use
/// it, so no database is ranked ahead of another.
const SOURCE_ORDER: &str = "CASE a.source WHEN 'user' THEN 0 WHEN 'bioart' THEN 1 WHEN 'bioicons' THEN 2 \
    WHEN 'servier' THEN 3 WHEN 'scidraw' THEN 4 WHEN 'healthicons' THEN 5 WHEN 'reactome' THEN 6 \
    WHEN 'openmoji' THEN 7 ELSE 9 END";

/// One value per result tile: a BioArt accession holds recolours of one drawing (its `variant`s are
/// colour names), shown as one icon. Everything else is its own icon: Health Icons' filled and
/// outline styles are different drawings, and so are assets that only share a title (SciDraw has
/// several "mouse head"s).
const GROUP_KEY: &str = "CASE a.source WHEN 'bioart' THEN coalesce(json_extract(a.extra, '$.accession'), a.id) ELSE a.id END";
/// [`GROUP_KEY`] for catalogs with the `grp` column, which data/publish_catalog.py fills from the
/// accessions and from image hashes, so byte-identical copies (BioArt files listed under two
/// accessions, OpenMoji's shared flags) share a tile too.
const GROUP_KEY_GRP: &str = "coalesce(a.grp, a.id)";
/// [`GROUP_KEY`] for catalogs without the `extra` column: a BioArt title stands in for its accession.
const GROUP_KEY_NO_EXTRA: &str = "CASE a.source WHEN 'bioart' THEN 'bioart' || char(31) || coalesce(a.title,'') ELSE a.id END";
/// Pairs one Health Icons pictogram's styles (`filled/x`, `outline/x`), which are separate icons
/// but switch as style presets; NULL elsewhere. Titles won't do: several pictograms share one.
const STYLE_KEY: &str = "CASE a.source WHEN 'healthicons' THEN substr(a.source_id, instr(a.source_id, '/') + 1) END";
/// [`STYLE_KEY`] for catalogs without the `source_id` column.
const STYLE_KEY_NO_SOURCE_ID: &str = "CASE a.source WHEN 'healthicons' THEN a.title END";

const COLS: &str = "a.id, a.source, a.source_name, coalesce(a.title,''), coalesce(a.variant,''), coalesce(a.category,''), \
    a.license, a.credit, coalesce(a.author,''), a.png_key, a.png_local, coalesce(a.png_width,0), coalesce(a.png_height,0)";

/// The local star table (`usage.stars`), joined as `ls`; see [`Worker::stars_cols`].
const STARS_JOIN: &str = "LEFT JOIN usage.stars ls ON ls.id = a.id";

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<AssetRow> {
    let (source, category, title, tags): (String, String, String, String) = (r.get(1)?, r.get(5)?, r.get(3)?, r.get(16)?);
    Ok(AssetRow {
        id: r.get(0)?,
        source: r.get(1)?,
        source_name: r.get(2)?,
        title: r.get(3)?,
        variant: r.get(4)?,
        category: r.get(5)?,
        license: r.get(6)?,
        credit: r.get(7)?,
        author: r.get(8)?,
        png_key: r.get(9)?,
        png_local: r.get(10)?,
        png_width: r.get::<_, i64>(11)? as u32,
        png_height: r.get::<_, i64>(12)? as u32,
        stars: r.get(13)?,
        starred: r.get::<_, i64>(14)? != 0,
        svg_key: r.get(15)?,
        description: r.get(17)?,
        taxa: crate::taxonomy::classify(&source, &category, &title, &tags),
    })
}


pub struct Worker {
    pub conn: Connection,
    pub fts: bool,
    /// Distinct words of every title, tag and category, most used first, for typo and mid-word
    /// matching. Built by the first search that needs it.
    vocab: std::cell::OnceCell<Vec<String>>,
    /// The catalog has the `stars` column (added here when the file is writable; catalogs
    /// published before stars, opened read-only, count as 0).
    stars_col: bool,
    /// [`GROUP_KEY`], or its stand-in when the catalog lacks the column it reads.
    group_key: &'static str,
    /// 1 on a copy of an identical image (the catalog's `dup` column), or 0 where it has none.
    dup: &'static str,
    /// [`STYLE_KEY`], or its stand-in when the catalog lacks the column it reads.
    style_key: &'static str,
    /// `a.svg_key`, or NULL in catalogs without the column.
    svg_key: &'static str,
    /// `usage.stars` exists (it can't be created on a read-only connection to an old usage file).
    local_stars: bool,
    /// `usage.uses` exists (it can't be created on a read-only connection with no usage file,
    /// since the in-memory stand-in is then read-only too).
    local_uses: bool,
    /// `temp.asset_taxa` (each asset's place in `crate::taxonomy`) has been built.
    taxa: std::cell::Cell<bool>,
}

/// The full-text index. `porter` stems words, so "cells" finds "cell". Keep in step with
/// `FTS_SQL` in `data/publish_catalog.py`.
const FTS_SQL: &str = "DROP TABLE IF EXISTS assets_fts; \
    CREATE VIRTUAL TABLE assets_fts USING fts5(title, description, tags, category, variant, \
    content='assets', content_rowid='rowid', tokenize='porter unicode61'); \
    INSERT INTO assets_fts(assets_fts) VALUES('rebuild'); \
    INSERT INTO assets_fts(assets_fts, rank) VALUES('rank', 'bm25(10.0, 1.0, 3.0, 1.0, 0.5)');";

/// One query word's FTS5 term (see [`Worker::fts_term`]).
struct Term {
    expr: String,
    /// The part of `expr` for the word as typed, when `expr` adds related words to it.
    typed: Option<String>,
}

/// Most alternative words one unmatched query word is replaced with.
const MAX_ALTERNATIVES: usize = 30;

impl Worker {
    /// `usage` holds the use counts; it is a separate file so it survives catalog updates.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open(path: &Path, usage: &Path) -> Result<Self, String> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("open {}: {e}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| e.to_string())?;
        Self::init(conn, usage)
    }

    /// For the CLI and MCP server: never writes to the catalog (a missing FTS index means LIKE
    /// search rather than a rebuild). `usage` may still be the app's file, so "popular" works.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open_readonly(path: &Path, usage: &Path) -> Result<Self, String> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        Self::init(conn, usage)
    }

    /// A catalog held in memory, deserialized from the file's bytes (the web build has no file
    /// system). Use counts are not kept.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let mut conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.deserialize_read_exact(rusqlite::MAIN_DB, bytes, bytes.len(), false)
            .map_err(|e| format!("load catalog: {e}"))?;
        Self::init(conn, Path::new(""))
    }

    pub fn init(conn: Connection, usage: &Path) -> Result<Self, String> {
        let usage = if usage.as_os_str().is_empty() {
            ":memory:".to_string()
        } else {
            // The catalog connection can't create files, so ATTACH needs the file to exist.
            Connection::open(usage).map_err(|e| format!("open {}: {e}", usage.display()))?;
            usage.display().to_string()
        };
        conn.execute("ATTACH DATABASE ?1 AS usage", params![usage]).map_err(|e| format!("open {usage}: {e}"))?;
        let local_uses = match conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage.uses (source TEXT NOT NULL, title TEXT NOT NULL, n INTEGER NOT NULL, \
             PRIMARY KEY (source, title));",
        ) {
            Ok(()) => true,
            Err(e) => {
                log::info!("no local use table ({e})");
                false
            }
        };
        let local_stars = match conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage.stars (id TEXT PRIMARY KEY, n INTEGER NOT NULL, mine INTEGER NOT NULL DEFAULT 0);",
        ) {
            Ok(()) => true,
            Err(e) => {
                log::info!("no local star table ({e})");
                false
            }
        };
        let has_col = |name: &str| -> bool {
            conn.query_row("SELECT count(*) FROM pragma_table_info('assets') WHERE name = ?1", params![name], |r| r.get::<_, i64>(0))
                .map(|n| n > 0)
                .unwrap_or(false)
        };
        let stars_col = has_col("stars") || {
            // Catalogs published before stars: add the column (instant, it is metadata only).
            match conn.execute_batch("ALTER TABLE assets ADD COLUMN stars INTEGER NOT NULL DEFAULT 0;") {
                Ok(()) => true,
                Err(e) => {
                    log::info!("catalog has no stars column ({e})");
                    false
                }
            }
        };
        let sql: String = conn
            .query_row("SELECT coalesce(max(sql),'') FROM sqlite_master WHERE name='assets_fts'", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        // An interrupted build leaves an empty index behind; detect that and rebuild.
        let populated = !sql.is_empty()
            && conn
                .query_row("SELECT count(*) FROM assets_fts_data", [], |r| r.get::<_, i64>(0))
                .map(|n| n > 10)
                .unwrap_or(false);
        let mut fts = populated;
        // Catalogs published before stemming have a plain index; rebuilding takes well under a second.
        if !populated || !sql.contains("porter") {
            log::info!("building FTS index for assets (one-off)...");
            match conn.execute_batch(&format!("BEGIN; {FTS_SQL} COMMIT;")) {
                Ok(()) => fts = true,
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    if populated {
                        log::info!("keeping the existing FTS index ({e})");
                    } else {
                        log::warn!("FTS unavailable ({e}); falling back to LIKE search");
                    }
                }
            }
        }
        let (group_key, dup) = if has_col("grp") && has_col("dup") {
            (GROUP_KEY_GRP, "a.dup")
        } else if has_col("extra") {
            (GROUP_KEY, "0")
        } else {
            (GROUP_KEY_NO_EXTRA, "0")
        };
        let style_key = if has_col("source_id") { STYLE_KEY } else { STYLE_KEY_NO_SOURCE_ID };
        let svg_key = if has_col("svg_key") { "a.svg_key" } else { "NULL" };
        Ok(Self { conn, fts, vocab: Default::default(), stars_col, group_key, dup, style_key, svg_key, local_stars, local_uses, taxa: Default::default() })
    }

    /// The star columns of a `SELECT ... FROM assets a {stars_join}`: the count (the local
    /// table's latest word over the catalog's snapshot) and whether it is starred here.
    pub fn stars_cols(&self) -> String {
        let snapshot = if self.stars_col { "coalesce(a.stars,0)" } else { "0" };
        if self.local_stars {
            format!("coalesce(ls.n, {snapshot}), coalesce(ls.mine, 0)")
        } else {
            format!("{snapshot}, 0")
        }
    }

    pub fn stars_join(&self) -> &'static str {
        if self.local_stars { STARS_JOIN } else { "" }
    }

    fn uses_join(&self) -> &'static str {
        if self.local_uses { USES_JOIN } else { NO_USES_JOIN }
    }

    /// Next to GROUP BY, makes SQLite take a group's bare columns from its plain (uncoloured) row,
    /// and an original over a copy.
    fn plain_first(&self) -> String {
        format!("MIN(2 * {} + CASE WHEN coalesce(a.variant,'')='' THEN 0 ELSE 1 END)", self.dup)
    }

    /// Every column of an [`AssetRow`] (see `row_from`).
    fn cols(&self) -> String {
        format!("{COLS}, {}, {}, coalesce(a.tags,''), coalesce(a.description,'')", self.stars_cols(), self.svg_key)
    }

    /// The words of a query as the index splits them (lowercase, alphanumeric runs).
    pub fn query_words(q: &str) -> Vec<String> {
        q.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.to_lowercase()).collect()
    }

    /// The FTS5 term for one query word: a prefix match when the word occurs (the index stems
    /// it, so "cells" is "cell"*), or-ed with its related words ("mouse" -> rat, hamster...; see
    /// [`crate::synonyms`]). With neither in the catalog, an OR of the catalog words that contain
    /// it or are a typo away from it ("cyte" -> lymphocyte, erythrocyte...; "nueron" -> neuron).
    /// None when nothing comes close, so the word is ignored.
    fn fts_term(&self, w: &str) -> rusqlite::Result<Option<Term>> {
        let quote = |a: &str| format!("\"{a}\"");
        let any_of = |alts: Vec<String>| if alts.len() == 1 { alts[0].clone() } else { format!("({})", alts.join(" OR ")) };
        let mut st = self.conn.prepare_cached("SELECT 1 FROM assets_fts WHERE assets_fts MATCH ?1 LIMIT 1")?;
        let prefix = format!("{}*", quote(w));
        let typed = if st.exists(params![prefix])? { Some(prefix) } else { None };
        let mut related = Vec::new();
        for r in crate::synonyms::related(w) {
            if st.exists(params![quote(r)])? {
                related.push(quote(r));
            }
        }
        let typed = match typed {
            Some(t) => Some(t),
            None if !related.is_empty() => None,
            None => {
                let alts = self.similar_words(w);
                if alts.is_empty() {
                    return Ok(None);
                }
                Some(any_of(alts.iter().map(|a| quote(a)).collect()))
            }
        };
        let expr = any_of(typed.iter().cloned().chain(related.iter().cloned()).collect());
        Ok(Some(Term { expr, typed: typed.filter(|_| !related.is_empty()) }))
    }

    /// Catalog words containing `w`, or within a typo or two of it (or of their start, so a
    /// half-typed word works too), most used first.
    fn similar_words(&self, w: &str) -> Vec<String> {
        let w: Vec<char> = w.chars().collect();
        if w.len() < 3 {
            return Vec::new();
        }
        let max = match w.len() {
            0..=4 => 0,
            5..=8 => 1,
            _ => 2,
        };
        let ws: String = w.iter().collect();
        let vocab = self.vocab.get_or_init(|| self.load_vocab().unwrap_or_default());
        vocab
            .iter()
            .filter(|v| {
                if v.contains(&ws) {
                    return true;
                }
                if max == 0 {
                    return false;
                }
                let v: Vec<char> = v.chars().collect();
                [v.len(), w.len(), w.len() + 1]
                    .iter()
                    .filter(|&&n| n <= v.len() && n.abs_diff(w.len()) <= max)
                    .any(|&n| edit_distance(&w, &v[..n]) <= max)
            })
            .take(MAX_ALTERNATIVES)
            .cloned()
            .collect()
    }

    fn load_vocab(&self) -> rusqlite::Result<Vec<String>> {
        let mut counts = std::collections::HashMap::<String, u32>::new();
        let mut st = self.conn.prepare(
            "SELECT coalesce(title,'') || ' ' || coalesce(tags,'') || ' ' || coalesce(category,'') FROM assets WHERE png_key IS NOT NULL",
        )?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let text: String = r.get(0)?;
            for w in Self::query_words(&text) {
                if w.chars().count() >= 3 {
                    *counts.entry(w).or_default() += 1;
                }
            }
        }
        let mut v: Vec<(String, u32)> = counts.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(v.into_iter().map(|(w, _)| w).collect())
    }

    /// Picks the best `limit` matches (by relevance; no collection is ranked ahead of another) and
    /// returns them in `sort` order.
    pub fn search(&self, query: &str, sources: &[String], limit: usize, sort: IconSort) -> rusqlite::Result<Vec<AssetRow>> {
        self.search_page(query, sources, None, 0, limit, sort)
    }

    /// [`Self::search`] within one category of `crate::taxonomy` (`(category, "")` for all of
    /// its subcategories).
    pub fn search_in(
        &self,
        query: &str,
        sources: &[String],
        taxon: Option<(&str, &str)>,
        limit: usize,
        sort: IconSort,
    ) -> rusqlite::Result<Vec<AssetRow>> {
        self.search_page(query, sources, taxon, 0, limit, sort)
    }

    /// [`Self::search_in`], skipping the first `offset` results (for loading more as the list
    /// scrolls). Every match is in `sort` order, so the pages line up.
    pub fn search_page(
        &self,
        query: &str,
        sources: &[String],
        taxon: Option<(&str, &str)>,
        offset: usize,
        limit: usize,
        sort: IconSort,
    ) -> rusqlite::Result<Vec<AssetRow>> {
        let mut filter = Filter::sources(sources);
        filter.taxa.extend(taxon.map(|(c, s)| (c.to_string(), s.to_string())));
        self.search_filtered(query, &filter, offset, limit, sort)
    }

    /// ` AND (...)` keeping the assets that pass `f`, or nothing when it keeps everything.
    fn filter_sql(&self, f: &Filter) -> rusqlite::Result<String> {
        let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let mut sql = src_filter(&f.sources);
        let authors: Vec<String> = f.authors.iter().map(|a| a.trim().to_lowercase()).filter(|a| !a.is_empty()).collect();
        if !authors.is_empty() {
            let any: Vec<String> = authors.iter().map(|a| format!("instr(lower(coalesce(a.author,'')), {}) > 0", q(a))).collect();
            sql += &format!(" AND ({})", any.join(" OR "));
        }
        if !f.licenses.is_empty() {
            sql += &format!(" AND a.license IN ({})", f.licenses.iter().map(|l| q(l)).collect::<Vec<_>>().join(","));
        }
        if !f.taxa.is_empty() {
            self.ensure_taxa()?;
            let any: Vec<String> = f
                .taxa
                .iter()
                .map(|(c, s)| if s.is_empty() { format!("cat = {}", q(c)) } else { format!("(cat = {} AND sub = {})", q(c), q(s)) })
                .collect();
            sql += &format!(" AND a.rowid IN (SELECT rid FROM temp.asset_taxa WHERE {})", any.join(" OR "));
        }
        if !f.db_cats.is_empty() {
            let any: Vec<String> = f
                .db_cats
                .iter()
                .map(|(src, c)| {
                    format!(
                        "(a.source = {} AND ({SHOWN_SOURCE}) = {} AND (coalesce(a.category,'') = {c} OR instr(', ' || a.category || ', ', {}) > 0))",
                        q(stored_source(src)),
                        q(src),
                        q(&format!(", {c}, ")),
                        c = q(c)
                    )
                })
                .collect();
            sql += &format!(" AND ({})", any.join(" OR "));
        }
        let svg = f.formats.iter().any(|x| x == FORMAT_SVG);
        let png = f.formats.iter().any(|x| x == FORMAT_PNG);
        if svg != png {
            sql += &format!(" AND {} IS {}NULL", self.svg_key, if svg { "NOT " } else { "" });
        }
        Ok(sql)
    }

    /// [`Self::search_page`] keeping what passes `filter`. An empty query lists everything that does.
    pub fn search_filtered(&self, query: &str, filter: &Filter, offset: usize, limit: usize, sort: IconSort) -> rusqlite::Result<Vec<AssetRow>> {
        let gk = self.group_key;
        let pf = self.plain_first();
        let src_filter = self.filter_sql(filter)?;
        let (cols, stars_join, uses_join) = (self.cols(), self.stars_join(), self.uses_join());
        // `inner` picks one row per icon (`rid`, with its match `score`); `page` is the LIMIT and
        // OFFSET placeholders.
        let wrap = |inner: String, order: &str, page: &str| {
            format!("SELECT {cols} FROM ({inner}) m JOIN assets a ON a.rowid = m.rid {uses_join} {stars_join} ORDER BY {order} {page}")
        };
        let q = query.trim();
        if q.is_empty() {
            let order = sort.without_score().sql();
            // Bare `a.rowid` next to MIN() takes the row with the minimum (the plain variant).
            let sql = wrap(
                format!("SELECT a.rowid AS rid, {pf} AS score FROM assets a WHERE a.png_key IS NOT NULL {src_filter} GROUP BY {gk}"),
                &order,
                "LIMIT ?1 OFFSET ?2",
            );
            let mut st = self.conn.prepare(&sql)?;
            let rows = st.query_map(params![limit as i64, offset as i64], row_from)?.collect();
            return rows;
        }
        if !self.fts {
            let sql = wrap(
                format!(
                    "SELECT a.rowid AS rid, {pf} AS score \
                     FROM assets a WHERE (a.title LIKE ?1 OR a.tags LIKE ?1) AND a.png_key IS NOT NULL {src_filter} \
                     GROUP BY {gk}"
                ),
                &if sort == IconSort::Relevance { "length(a.title), a.id".into() } else { sort.sql() },
                "LIMIT ?2 OFFSET ?3",
            );
            let mut st = self.conn.prepare(&sql)?;
            let rows = st.query_map(params![format!("%{q}%"), limit as i64, offset as i64], row_from)?.collect();
            return rows;
        }
        let query_terms = self.fts_query(q)?;
        if query_terms.is_empty() {
            return Ok(Vec::new());
        }
        let terms: Vec<String> = query_terms.iter().map(|t| t.expr.clone()).collect();
        let matched = |expr: &str| format!(
            "(SELECT rowid, rank AS r FROM assets_fts WHERE assets_fts MATCH {expr}) f JOIN assets a ON a.rowid = f.rowid \
             WHERE a.png_key IS NOT NULL {src_filter}"
        );
        // Every word first; when no asset has them all, any of them, best match first
        // (bm25 ranks assets matching more of the words higher).
        let all = terms.join(" AND ");
        let any = terms.len() > 1 && !self.conn.query_row(&format!("SELECT EXISTS (SELECT 1 FROM {})", matched("?1")), params![all], |r| r.get::<_, bool>(0))?;
        let expr = if any { terms.join(" OR ") } else { all };
        // Icons found only through a related word ("rat" for "mouse") come after every icon with
        // the words as typed.
        let typed: Vec<String> = query_terms.iter().map(|t| t.typed.clone().unwrap_or_else(|| t.expr.clone())).collect();
        let related = if typed == terms {
            String::new()
        } else {
            let typed = if any { typed.join(" OR ") } else { typed.join(" AND ") };
            format!(
                " + CASE WHEN a.rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH '{}') THEN 0 ELSE 1000 END",
                typed.replace('\'', "''")
            )
        };
        let order = sort.sql();
        // Bare `a.rowid` next to MIN() takes the row with the minimum: the best match, and among
        // equal ones the plain variant (unless only a coloured one matches, as for "red flask"),
        // and an original over a copy.
        let dup = self.dup;
        let sql = wrap(
            format!(
                "SELECT a.rowid AS rid, MIN(f.r + CASE WHEN coalesce(a.variant,'')='' THEN 0 ELSE 0.001 END + 0.002 * {dup}{related}) AS score \
                 FROM {} GROUP BY {gk}",
                matched("?1")
            ),
            &order,
            "LIMIT ?2 OFFSET ?3",
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params![expr, limit as i64, offset as i64], row_from)?.collect();
        rows
    }

    /// The FTS5 terms of a query's words (see [`Self::fts_term`]).
    fn fts_terms(&self, q: &str) -> rusqlite::Result<Vec<String>> {
        Ok(self.fts_query(q)?.into_iter().map(|t| t.expr).collect())
    }

    fn fts_query(&self, q: &str) -> rusqlite::Result<Vec<Term>> {
        let mut terms = Vec::new();
        for w in Self::query_words(q) {
            if let Some(t) = self.fts_term(&w)? {
                terms.push(t);
            }
        }
        Ok(terms)
    }

    /// How many icons `search` could return with no limit (it shows at most `limit`).
    pub fn search_total(&self, query: &str, sources: &[String]) -> rusqlite::Result<i64> {
        self.search_filtered_total(query, &Filter::sources(sources))
    }

    /// How many icons `search_filtered` could return with no limit.
    pub fn search_filtered_total(&self, query: &str, filter: &Filter) -> rusqlite::Result<i64> {
        let gk = self.group_key;
        let src_filter = self.filter_sql(filter)?;
        let count = |inner: String, arg: Option<String>| -> rusqlite::Result<i64> {
            let sql = format!("SELECT count(*) FROM ({inner} GROUP BY {gk})");
            match arg {
                Some(a) => self.conn.query_row(&sql, params![a], |r| r.get(0)),
                None => self.conn.query_row(&sql, [], |r| r.get(0)),
            }
        };
        let q = query.trim();
        if q.is_empty() {
            return count(format!("SELECT 1 FROM assets a WHERE a.png_key IS NOT NULL {src_filter}"), None);
        }
        if !self.fts {
            return count(
                format!("SELECT 1 FROM assets a WHERE (a.title LIKE ?1 OR a.tags LIKE ?1) AND a.png_key IS NOT NULL {src_filter}"),
                Some(format!("%{q}%")),
            );
        }
        let terms = self.fts_terms(q)?;
        if terms.is_empty() {
            return Ok(0);
        }
        let fts = |expr: String| {
            count(
                format!(
                    "SELECT 1 FROM (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?1) f JOIN assets a ON a.rowid = f.rowid \
                     WHERE a.png_key IS NOT NULL {src_filter}"
                ),
                Some(expr),
            )
        };
        // The same fallback as `search`: every word, else any of them.
        let all = fts(terms.join(" AND "))?;
        if all > 0 || terms.len() == 1 {
            return Ok(all);
        }
        fts(terms.join(" OR "))
    }

    pub fn browse(&self, source: &str, category: Option<&str>, offset: usize, limit: usize, sort: IconSort) -> rusqlite::Result<Vec<AssetRow>> {
        let gk = self.group_key;
        let source_is = source_is();
        let pf = self.plain_first();
        let (cat_sql, cat_arg) = category_filter(category);
        let sql = format!(
            "SELECT {cols}, {pf} FROM assets a {uses_join} {stars_join} \
             WHERE {source_is} AND a.png_key IS NOT NULL {cat_sql} GROUP BY {gk} \
             ORDER BY {order} LIMIT ?3 OFFSET ?4",
            cols = self.cols(),
            stars_join = self.stars_join(),
            uses_join = self.uses_join(),
            order = sort.without_score().sql()
        );
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(params![source, cat_arg, limit as i64, offset as i64], row_from)?.collect();
        rows
    }

    /// How many icons `browse` could return with no limit.
    pub fn browse_total(&self, source: &str, category: Option<&str>) -> rusqlite::Result<i64> {
        let gk = self.group_key;
        let source_is = source_is();
        let (cat_sql, cat_arg) = category_filter(category);
        self.conn.query_row(
            &format!("SELECT count(*) FROM (SELECT 1 FROM assets a WHERE {source_is} AND a.png_key IS NOT NULL {cat_sql} GROUP BY {gk})"),
            params![source, cat_arg],
            |r| r.get(0),
        )
    }

    /// A database's categories, alphabetical, with how many icons each holds. An asset filed
    /// under several ("Viruses, Molecules") counts in each; "" (uncategorized) comes last.
    pub fn categories(&self, source: &str) -> rusqlite::Result<Vec<CategoryInfo>> {
        let gk = self.group_key;
        let source_is = source_is();
        let mut st = self.conn.prepare(&format!(
            "SELECT DISTINCT coalesce(a.category,''), {gk} FROM assets a WHERE {source_is} AND a.png_key IS NOT NULL"
        ))?;
        let mut titles: std::collections::HashMap<String, std::collections::HashSet<String>> = Default::default();
        let mut rows = st.query(params![source])?;
        while let Some(r) = rows.next()? {
            let (cat, title): (String, String) = (r.get(0)?, r.get(1)?);
            let labels: Vec<&str> = cat.split(", ").map(str::trim).filter(|l| !l.is_empty()).collect();
            if labels.is_empty() {
                titles.entry(String::new()).or_default().insert(title);
            } else {
                for l in labels {
                    titles.entry(l.to_string()).or_default().insert(title.clone());
                }
            }
        }
        let mut cats: Vec<CategoryInfo> = titles.into_iter().map(|(name, t)| CategoryInfo { name, count: t.len() as i64 }).collect();
        cats.sort_by(|a, b| a.name.is_empty().cmp(&b.name.is_empty()).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(cats)
    }

    /// Fill `temp.asset_taxa` with every asset's taxa, once.
    fn ensure_taxa(&self) -> rusqlite::Result<()> {
        if self.taxa.get() {
            return Ok(());
        }
        self.conn.execute_batch(
            "DROP TABLE IF EXISTS temp.asset_taxa; \
             CREATE TEMP TABLE asset_taxa (rid INTEGER NOT NULL, cat TEXT NOT NULL, sub TEXT NOT NULL); BEGIN;",
        )?;
        let filled: rusqlite::Result<()> = (|| {
            let mut ins = self.conn.prepare("INSERT INTO temp.asset_taxa (rid, cat, sub) VALUES (?1, ?2, ?3)")?;
            let mut st = self.conn.prepare(
                "SELECT rowid, source, coalesce(category,''), coalesce(title,''), coalesce(tags,'') FROM assets WHERE png_key IS NOT NULL",
            )?;
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                let (rid, source, cat, title, tags): (i64, String, String, String, String) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?);
                for (c, s) in crate::taxonomy::classify(&source, &cat, &title, &tags) {
                    ins.execute(params![rid, c, s])?;
                }
            }
            Ok(())
        })();
        if let Err(e) = filled {
            let _ = self.conn.execute_batch("ROLLBACK;");
            return Err(e);
        }
        self.conn.execute_batch(
            "COMMIT; CREATE INDEX temp.asset_taxa_cat ON asset_taxa (cat, sub); CREATE INDEX temp.asset_taxa_rid ON asset_taxa (rid);",
        )?;
        self.taxa.set(true);
        Ok(())
    }

    /// The `WHERE` terms of a taxonomy browse: `?1` is the category and `?2` the subcategory
    /// ("" for all).
    fn taxon_filter(sources: &[String]) -> String {
        format!(
            "a.png_key IS NOT NULL {} AND (?1 = '' OR a.rowid IN \
             (SELECT rid FROM temp.asset_taxa WHERE cat = ?1 AND (?2 = '' OR sub = ?2)))",
            src_filter(sources)
        )
    }

    pub fn browse_taxon(
        &self,
        cat: Option<&str>,
        sub: Option<&str>,
        sources: &[String],
        offset: usize,
        limit: usize,
        sort: IconSort,
    ) -> rusqlite::Result<(Vec<AssetRow>, i64)> {
        let gk = self.group_key;
        let pf = self.plain_first();
        self.ensure_taxa()?;
        let (cat, sub) = (cat.unwrap_or(""), sub.unwrap_or(""));
        let filter = Self::taxon_filter(sources);
        let sql = format!(
            "SELECT {cols}, {pf} FROM assets a {uses_join} {stars_join} \
             WHERE {filter} GROUP BY {gk} ORDER BY {order} LIMIT ?3 OFFSET ?4",
            cols = self.cols(),
            stars_join = self.stars_join(),
            uses_join = self.uses_join(),
            order = sort.without_score().sql()
        );
        let rows = self.conn.prepare(&sql)?.query_map(params![cat, sub, limit as i64, offset as i64], row_from)?.collect::<rusqlite::Result<_>>()?;
        let total = self.conn.query_row(
            &format!("SELECT count(*) FROM (SELECT 1 FROM assets a WHERE {filter} GROUP BY {gk})"),
            params![cat, sub],
            |r| r.get(0),
        )?;
        Ok((rows, total))
    }

    /// Icon counts of every category and subcategory that has any, under `sources`.
    pub fn taxonomy(&self, sources: &[String]) -> rusqlite::Result<Vec<TaxonCount>> {
        self.taxonomy_filtered(&Filter::sources(sources))
    }

    /// [`Self::taxonomy`] of what passes `filter`.
    pub fn taxonomy_filtered(&self, filter: &Filter) -> rusqlite::Result<Vec<TaxonCount>> {
        self.ensure_taxa()?;
        self.taxonomy_where(&self.filter_sql(filter)?)
    }

    /// [`Self::taxonomy_filtered`] of the assets passing `src`, `filter_sql`'s " AND ..." terms.
    fn taxonomy_where(&self, src: &str) -> rusqlite::Result<Vec<TaxonCount>> {
        let gk = self.group_key;
        self.ensure_taxa()?;
        let key = format!("count(DISTINCT {gk})");
        let sql = format!(
            "SELECT t.cat, t.sub, {key} FROM temp.asset_taxa t JOIN assets a ON a.rowid = t.rid WHERE 1 {src} GROUP BY t.cat, t.sub \
             UNION ALL SELECT t.cat, '', {key} FROM temp.asset_taxa t JOIN assets a ON a.rowid = t.rid WHERE 1 {src} GROUP BY t.cat \
             UNION ALL SELECT '', '', {key} FROM assets a WHERE a.png_key IS NOT NULL {src}"
        );
        let rows = self.conn.prepare(&sql)?.query_map([], |r| Ok(TaxonCount { cat: r.get(0)?, sub: r.get(1)?, count: r.get(2)? }))?.collect();
        rows
    }

    /// The choices of a search's filters that still find icons: each counted under the other
    /// filters, so picking a database narrows the categories and licenses but not the databases.
    /// A `query` counts only the icons it finds (as `search_filtered` does).
    pub fn facets(&self, query: &str, filter: &Filter) -> rusqlite::Result<Facets> {
        let gk = self.group_key;
        let matched = self.query_sql(query, filter)?;
        let src = |f: Filter| self.filter_sql(&f).map(|s| s + &matched);
        let counts = |col: &str, f: Filter| -> rusqlite::Result<Vec<(String, i64)>> {
            let sql = format!(
                "SELECT {col} AS v, count(DISTINCT {gk}) FROM assets a WHERE a.png_key IS NOT NULL {} AND coalesce({col},'') <> '' GROUP BY v ORDER BY v",
                src(f)?
            );
            let rows = self.conn.prepare(&sql)?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
            rows
        };
        Ok(Facets {
            sources: counts(&format!("({SHOWN_SOURCE})"), Filter { sources: Vec::new(), ..filter.clone() })?,
            licenses: counts("a.license", Filter { licenses: Vec::new(), ..filter.clone() })?,
            taxa: self.taxonomy_where(&src(Filter { taxa: Vec::new(), ..filter.clone() })?)?,
            db_cats: self.db_categories(&src(Filter { db_cats: Vec::new(), ..filter.clone() })?)?,
            formats: counts(
                &format!("CASE WHEN {} IS NULL THEN '{FORMAT_PNG}' ELSE '{FORMAT_SVG}' END", self.svg_key),
                Filter { formats: Vec::new(), ..filter.clone() },
            )?,
        })
    }

    /// An " AND ..." term keeping the assets `query` finds, "" for no query. Every word, else
    /// (when no asset passing `filter` has them all) any of them, as in `search_filtered`.
    fn query_sql(&self, query: &str, filter: &Filter) -> rusqlite::Result<String> {
        let lit = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let q = query.trim();
        if q.is_empty() {
            return Ok(String::new());
        }
        if !self.fts {
            let like = lit(&format!("%{q}%"));
            return Ok(format!(" AND (a.title LIKE {like} OR a.tags LIKE {like})"));
        }
        let terms = self.fts_terms(q)?;
        if terms.is_empty() {
            return Ok(" AND 0".into());
        }
        let matched = |expr: &str| format!(" AND a.rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH {})", lit(expr));
        let all = terms.join(" AND ");
        if terms.len() > 1 {
            let sql = format!("SELECT EXISTS (SELECT 1 FROM assets a WHERE a.png_key IS NOT NULL {}{})", self.filter_sql(filter)?, matched(&all));
            if !self.conn.query_row(&sql, [], |r| r.get::<_, bool>(0))? {
                return Ok(matched(&terms.join(" OR ")));
            }
        }
        Ok(matched(&all))
    }

    /// Every database's own categories with icons passing `src` (`filter_sql`'s terms), as in
    /// [`Self::categories`] (uncategorized ones left out), by database then category.
    fn db_categories(&self, src: &str) -> rusqlite::Result<Vec<(String, String, i64)>> {
        let gk = self.group_key;
        let mut st = self.conn.prepare(&format!("SELECT DISTINCT {SHOWN_SOURCE}, coalesce(a.category,''), {gk} FROM assets a WHERE a.png_key IS NOT NULL {src}"))?;
        let mut icons: std::collections::HashMap<(String, String), std::collections::HashSet<String>> = Default::default();
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let (src, cat, key): (String, String, String) = (r.get(0)?, r.get(1)?, r.get(2)?);
            for l in cat.split(", ").map(str::trim).filter(|l| !l.is_empty()) {
                icons.entry((src.clone(), l.to_string())).or_default().insert(key.clone());
            }
        }
        let mut out: Vec<(String, String, i64)> = icons.into_iter().map(|((s, c), k)| (s, c, k.len() as i64)).collect();
        out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
        Ok(out)
    }

    pub fn sources(&self) -> rusqlite::Result<Vec<SourceInfo>> {
        let gk = self.group_key;
        let mut st = self.conn.prepare(&format!(
            "SELECT {SHOWN_SOURCE} AS s, CASE WHEN {SHOWN_SOURCE} = 'biocartoon' THEN 'BioCartoon' ELSE a.source_name END, \
             count(*), count(DISTINCT {gk}), group_concat(DISTINCT a.license) FROM assets a \
             WHERE a.png_key IS NOT NULL GROUP BY s ORDER BY {}",
            SOURCE_ORDER.replace("CASE a.source", &format!("CASE s WHEN '{BIOCARTOON_SOURCE}' THEN -1"))
        ))?;
        let rows = st
            .query_map([], |r| {
                Ok(SourceInfo {
                    source: r.get(0)?,
                    name: r.get(1)?,
                    count: r.get(2)?,
                    icons: r.get(3)?,
                    licenses: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                })
            })?
            .collect();
        rows
    }

    /// The style presets of the icon with this id: its recolours (see [`GROUP_KEY`]) and its other
    /// Health Icons styles, copies of identical images left out. Not other icons that share its
    /// title: those are different drawings.
    pub fn variants(&self, id: &str) -> rusqlite::Result<Vec<AssetRow>> {
        let (gk, sk) = (self.group_key, self.style_key);
        let mut st = self.conn.prepare(&format!(
            "SELECT {} FROM assets a {} WHERE a.png_key IS NOT NULL AND NOT {} \
             AND ({gk} = (SELECT {gk} FROM assets a WHERE a.id=?1) OR {sk} = (SELECT {sk} FROM assets a WHERE a.id=?1)) \
             ORDER BY a.variant LIMIT 40",
            self.cols(),
            self.stars_join(),
            self.dup
        ))?;
        let rows = st.query_map(params![id], row_from)?.collect();
        rows
    }

    /// Every recolour of the icons with these ids (see [`GROUP_KEY`]), copies of identical images
    /// left out, in no particular order, by the asked-for id. Icons with no other colour are left out.
    pub fn recolors(&self, ids: &[String]) -> rusqlite::Result<std::collections::HashMap<String, Vec<AssetRow>>> {
        let gk = self.group_key;
        let mut out: std::collections::HashMap<String, Vec<AssetRow>> = Default::default();
        if ids.is_empty() {
            return Ok(out);
        }
        let marks = |n: usize| vec!["?"; n].join(",");
        // Which group each id is in. An id can be its group's key (a `grp` names the group's first
        // icon), so the groups' sizes, not their keys, tell which have other colours.
        let mut by_key: std::collections::HashMap<String, Vec<String>> = Default::default();
        let mut sources = std::collections::BTreeSet::new();
        let sql = format!("SELECT a.id, a.source, {gk} FROM assets a WHERE a.id IN ({})", marks(ids.len()));
        let mut st = self.conn.prepare(&sql)?;
        let mut rows = st.query(rusqlite::params_from_iter(ids))?;
        while let Some(r) = rows.next()? {
            let (id, source, key): (String, String, String) = (r.get(0)?, r.get(1)?, r.get(2)?);
            by_key.entry(key).or_default().push(id);
            sources.insert(source);
        }
        if by_key.is_empty() {
            return Ok(out);
        }
        let keys: Vec<&String> = by_key.keys().collect();
        let sql = format!(
            "SELECT {}, {gk} FROM assets a {} WHERE a.png_key IS NOT NULL AND NOT {} AND a.source IN ({}) AND {gk} IN ({}) ORDER BY a.id",
            self.cols(),
            self.stars_join(),
            self.dup,
            marks(sources.len()),
            marks(keys.len())
        );
        let mut st = self.conn.prepare(&sql)?;
        let args = sources.iter().map(|s| s as &dyn rusqlite::ToSql).chain(keys.iter().map(|k| *k as &dyn rusqlite::ToSql)).collect::<Vec<_>>();
        let mut groups: std::collections::HashMap<String, Vec<AssetRow>> = Default::default();
        let mut rows = st.query(args.as_slice())?;
        while let Some(r) = rows.next()? {
            // `{gk}` comes after the 18 columns of `row_from`.
            groups.entry(r.get(18)?).or_default().push(row_from(r)?);
        }
        for (key, group) in groups {
            if group.len() > 1 {
                for id in &by_key[&key] {
                    out.insert(id.clone(), group.clone());
                }
            }
        }
        Ok(out)
    }

    /// The rows with these ids (in no particular order); ids the catalog lacks are left out.
    pub fn by_ids(&self, ids: &[String]) -> rusqlite::Result<Vec<AssetRow>> {
        let mut out = Vec::new();
        let mut st = self.conn.prepare(&format!("SELECT {} FROM assets a {} WHERE a.id=?1", self.cols(), self.stars_join()))?;
        for id in ids {
            if let Some(r) = st.query_map(params![id], row_from)?.next() {
                out.push(r?);
            }
        }
        Ok(out)
    }

    pub fn insert_user(&self, row: &AssetRow) -> rusqlite::Result<()> {
        // Same license urls and attribution flags as data/uploads.py gives published uploads. No hash
        // columns: publish_catalog.py's UNPUBLISHED_COLS leaves them out of the catalog.
        let (license_url, attribution) = match row.license.as_str() {
            "CC-BY-4.0" => (Some("https://creativecommons.org/licenses/by/4.0/"), 1),
            "CC0-1.0" => (Some("https://creativecommons.org/publicdomain/zero/1.0/"), 0),
            _ => (None, 0),
        };
        self.conn.execute(
            "INSERT OR REPLACE INTO assets (id, source, source_name, source_id, title, variant, description, category, \
             tags, license, license_raw, license_url, attribution_required, share_alike, author, source_url, doi, credit, \
             svg_key, png_key, png_is_raster, png_width, png_height, svg_bytes, png_bytes, \
             svg_local, png_local, extra, uploaded_at) VALUES (?1, 'user', 'User-generated', ?2, ?3, '', ?4, ?5, '[]', \
             ?6, ?6, ?14, ?15, 0, ?7, NULL, NULL, ?8, ?16, ?9, 0, ?10, ?11, NULL, NULL, NULL, ?12, ?13, NULL)",
            params![
                row.id,
                row.id,
                row.title,
                row.description,
                row.category,
                row.license,
                row.author,
                row.credit,
                row.png_key,
                row.png_width as i64,
                row.png_height as i64,
                row.png_local,
                "{\"generated\": true}",
                license_url,
                attribution,
                // An SVG the app keeps beside the PNG (a drawing an AI model made): drawn and exported instead.
                row.svg_key,
            ],
        )?;
        if self.fts {
            // External-content FTS tables must be told about new rows explicitly.
            let _ = self.conn.execute(
                "INSERT INTO assets_fts(rowid, title, description, tags, category, variant) \
                 SELECT rowid, title, description, tags, category, variant FROM assets WHERE id=?1",
                params![row.id],
            );
        }
        if self.taxa.get() {
            let rid: i64 = self.conn.query_row("SELECT rowid FROM assets WHERE id=?1", params![row.id], |r| r.get(0))?;
            self.conn.execute("DELETE FROM temp.asset_taxa WHERE rid=?1", params![rid])?;
            for (c, s) in crate::taxonomy::classify("user", &row.category, &row.title, "") {
                self.conn.execute("INSERT INTO temp.asset_taxa (rid, cat, sub) VALUES (?1, ?2, ?3)", params![rid, c, s])?;
            }
        }
        Ok(())
    }

    /// Take an asset [`Self::insert_user`] added back out of the local catalog. Only the user's own
    /// copies (with a `png_local`) go: a published upload would come back with the next catalog.
    /// The PNG stays on disk, for documents that placed it. False when there was no such row.
    pub fn remove_user(&self, id: &str) -> rusqlite::Result<bool> {
        let own = "source='user' AND png_local IS NOT NULL";
        let Some(rid) = self.conn.query_row(&format!("SELECT rowid FROM assets WHERE id=?1 AND {own}"), params![id], |r| r.get::<_, i64>(0)).optional()? else {
            return Ok(false);
        };
        if self.fts {
            // External-content FTS tables are told about deletions with the row's old values.
            let _ = self.conn.execute(
                "INSERT INTO assets_fts(assets_fts, rowid, title, description, tags, category, variant) \
                 SELECT 'delete', rowid, title, description, tags, category, variant FROM assets WHERE rowid=?1",
                params![rid],
            );
        }
        if self.taxa.get() {
            self.conn.execute("DELETE FROM temp.asset_taxa WHERE rid=?1", params![rid])?;
        }
        self.conn.execute("DELETE FROM assets WHERE rowid=?1", params![rid])?;
        Ok(true)
    }

    pub fn record_use(&self, source: &str, title: &str) -> rusqlite::Result<()> {
        if !self.local_uses {
            return Ok(());
        }
        self.conn.execute(
            "INSERT INTO usage.uses (source, title, n) VALUES (?1, ?2, 1) \
             ON CONFLICT (source, title) DO UPDATE SET n = n + 1",
            params![source, title],
        )?;
        Ok(())
    }

    pub fn set_stars(&self, updates: &[StarUpdate]) -> rusqlite::Result<()> {
        if !self.local_stars {
            return Ok(());
        }
        let mut st = self.conn.prepare_cached(
            "INSERT INTO usage.stars (id, n, mine) VALUES (?1, ?2, ?3) \
             ON CONFLICT (id) DO UPDATE SET n = excluded.n, mine = excluded.mine",
        )?;
        for u in updates {
            st.execute(params![u.id, u.n.max(0), i64::from(u.mine)])?;
        }
        Ok(())
    }
}

/// The catalog file most recently downloaded into `dir` by [`sync_catalog`], if any.
#[cfg(not(target_arch = "wasm32"))]
pub fn cached_catalog(dir: &Path) -> Option<PathBuf> {
    let name = std::fs::read_to_string(dir.join(CURRENT_FILE)).ok()?;
    let p = dir.join(name.trim());
    p.exists().then_some(p)
}

/// Names the active catalog file inside a catalog folder (see [`sync_catalog`]).
pub const CURRENT_FILE: &str = "current.txt";

/// Downloads the catalog published by `data/publish_catalog.py` (`<base>/catalog/version.txt`
/// and `<base>/catalog/assets.sqlite.gz`) into `dir`, keeping one file per version so the old
/// one can stay open while the new one is written. `dir/current.txt` names the active file.
/// `Ok(None)` means the cached copy is current; `bytes` counts the download as it goes.
#[cfg(not(target_arch = "wasm32"))]
pub fn sync_catalog(base: &str, dir: &Path, bytes: &AtomicU64) -> Result<Option<PathBuf>, String> {
    if base.is_empty() {
        return Err("No asset URL configured".into());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(300))).build().into();
    let version = agent
        .get(&format!("{base}/catalog/version.txt"))
        .call()
        .and_then(|mut r| r.body_mut().read_to_string())
        .map_err(|e| format!("catalog version: {e}"))?;
    let version: String = version.trim().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if version.is_empty() {
        return Err("catalog version is empty".into());
    }
    let name = format!("assets-{version}.sqlite");
    let dest = dir.join(&name);
    let previous = cached_catalog(dir);
    if previous.as_deref() == Some(dest.as_path()) {
        return Ok(None);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut res = agent.get(&format!("{base}/catalog/assets.sqlite.gz")).call().map_err(|e| format!("catalog download: {e}"))?;
    let tmp = dir.join(format!("{name}.part"));
    {
        let reader = Counting { inner: res.body_mut().as_reader(), bytes };
        let mut gz = flate2::read::GzDecoder::new(reader);
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::io::copy(&mut gz, &mut f).map_err(|e| format!("catalog download: {e}"))?;
    }
    // Carry the user's own uploads over; the published catalog only has what is in the bucket.
    if let Some(old) = &previous {
        if let Err(e) = copy_user_rows(old, &tmp) {
            log::warn!("could not carry user assets into the new catalog: {e}");
        }
    }
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(CURRENT_FILE), &name).map_err(|e| e.to_string())?;
    // Older versions may still be open (on Windows that makes removal fail); they go next launch.
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("assets-") && p != dest && previous.as_deref() != Some(p.as_path()) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    Ok(Some(dest))
}

#[cfg(not(target_arch = "wasm32"))]
fn copy_user_rows(old: &Path, new: &Path) -> rusqlite::Result<()> {
    let conn = Connection::open(new)?;
    conn.execute("ATTACH DATABASE ?1 AS old", params![old.display().to_string()])?;
    // Only the columns both catalogs have: a published catalog may have gained one (`stars`).
    let names = |db: &str| -> rusqlite::Result<Vec<String>> {
        conn.prepare("SELECT name FROM pragma_table_info('assets', ?1)")?.query_map(params![db], |r| r.get(0))?.collect()
    };
    let new_cols = names("main")?;
    let cols: Vec<String> = names("old")?.into_iter().filter(|c| new_cols.contains(c)).collect();
    let cols = cols.join(", ");
    conn.execute_batch(&format!(
        "INSERT OR IGNORE INTO assets ({cols}) SELECT {cols} FROM old.assets WHERE source='user'; \
         INSERT INTO assets_fts(rowid, title, description, tags, category, variant) \
         SELECT rowid, title, description, tags, category, variant FROM assets WHERE source='user'; \
         DETACH DATABASE old;"
    ))
}

#[cfg(not(target_arch = "wasm32"))]
struct Counting<'a, R> {
    inner: R,
    bytes: &'a AtomicU64,
}

#[cfg(not(target_arch = "wasm32"))]
impl<R: std::io::Read> std::io::Read for Counting<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/// A star count for a tile corner: "1", "999", "1k", "1.1k", "10k", "100k", "1M", "1.1M"...: at
/// most three digits (plus a decimal point). Tenths are cut, not rounded, so 1,999 reads "1.9k".
pub fn format_stars(n: i64) -> String {
    let n = n.max(0);
    if n < 1000 {
        return n.to_string();
    }
    let (unit, div) = if n < 1_000_000 {
        ('k', 1000)
    } else if n < 1_000_000_000 {
        ('M', 1_000_000)
    } else {
        ('B', 1_000_000_000)
    };
    let whole = n / div;
    let tenth = n % div * 10 / div;
    if whole < 10 && tenth > 0 {
        format!("{whole}.{tenth}{unit}")
    } else {
        format!("{whole}{unit}")
    }
}

/// Edit distance counting a swap of neighbouring letters as one edit (optimal string alignment).
fn edit_distance(a: &[char], b: &[char]) -> usize {
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in 0..=a.len() {
        d[i][0] = i;
    }
    for j in 0..=b.len() {
        d[0][j] = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    /// The columns of the test catalog; `stars` is left out, as in a catalog published before
    /// stars, so opening adds it.
    const TEST_COLS: &str = "id, source, source_name, title, variant, description, category, tags, license, credit, author, \
        png_key, png_local, png_width, png_height";

    fn worker(dir: &Path) -> Worker {
        let db = dir.join("assets.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, title TEXT, variant TEXT, \
             description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, png_key TEXT, \
             png_local TEXT, png_width INTEGER, png_height INTEGER);",
        )
        .unwrap();
        for (i, t) in ["beta cell", "Alpha cell", "gamma cell", "delta cell"].iter().enumerate() {
            c.execute(
                &format!("INSERT INTO assets ({TEST_COLS}) VALUES (?1, 'bioart', 'BioArt', ?2, '', '', 'cells', '[]', 'PD', '', '', ?1, NULL, 1, 1)"),
                params![format!("k{i}"), t],
            )
            .unwrap();
        }
        drop(c);
        Worker::open(&db, &dir.join("usage.sqlite")).unwrap()
    }

    fn titles(rows: Vec<AssetRow>) -> Vec<String> {
        rows.into_iter().map(|r| r.title).collect()
    }

    #[test]
    fn sort_orders_are_stable() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = worker(&dir);
        let az = vec!["Alpha cell", "beta cell", "delta cell", "gamma cell"];
        let za: Vec<_> = az.iter().rev().cloned().collect();
        assert_eq!(titles(w.search("", &[], 10, IconSort::Alphabetical).unwrap()), az);
        assert_eq!(titles(w.search("cell", &[], 10, IconSort::Alphabetical).unwrap()), az);
        assert_eq!(titles(w.search("cell", &[], 10, IconSort::ReverseAlphabetical).unwrap()), za);
        assert_eq!(titles(w.browse("bioart", Some("cells"), 0, 10, IconSort::ReverseAlphabetical).unwrap()), za);
        w.record_use("bioart", "gamma cell").unwrap();
        w.record_use("bioart", "gamma cell").unwrap();
        w.record_use("bioart", "delta cell").unwrap();
        let pop = vec!["gamma cell", "delta cell", "Alpha cell", "beta cell"];
        assert_eq!(titles(w.browse("bioart", None, 0, 10, IconSort::Popular).unwrap()), pop);
        assert_eq!(titles(w.search("", &[], 10, IconSort::Popular).unwrap()), pop);
        // Counts live in their own file, so they survive reopening (and catalog updates).
        drop(w);
        let w = Worker::open(&dir.join("assets.sqlite"), &dir.join("usage.sqlite")).unwrap();
        assert_eq!(titles(w.search("cell", &[], 10, IconSort::Popular).unwrap()), pop);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_forgives_plurals_typos_and_extra_words() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-fuzzy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = worker(&dir);
        let c = &w.conn;
        for (i, t) in ["lymphocyte", "pyramidal neuron", "red blood cell"].iter().enumerate() {
            c.execute(
                &format!("INSERT INTO assets ({TEST_COLS}) VALUES (?1, 'servier', 'Servier', ?2, '', '', '', '[]', 'CC', '', '', ?1, NULL, 1, 1)"),
                params![format!("s{i}"), t],
            )
            .unwrap();
        }
        c.execute_batch("INSERT INTO assets_fts(assets_fts) VALUES('rebuild');").unwrap();
        let az = |q: &str| titles(w.search(q, &[], 10, IconSort::Alphabetical).unwrap());
        assert_eq!(az("neurons"), vec!["pyramidal neuron"]);
        assert_eq!(az("blood cells"), vec!["red blood cell"]);
        assert_eq!(az("nueron"), vec!["pyramidal neuron"]);
        assert_eq!(az("pyramidl"), vec!["pyramidal neuron"]);
        assert_eq!(az("cyte"), vec!["lymphocyte"]);
        // No asset has every word: assets with any of them, more words matched first.
        assert_eq!(titles(w.search("red blood cell lymphocyte", &[], 1, IconSort::Relevance).unwrap()), vec!["red blood cell"]);
        assert_eq!(az("red blood cell lymphocyte").len(), 6);
        // A word nothing resembles is ignored.
        assert_eq!(az("red blood cell diagram"), vec!["red blood cell"]);
        assert!(az("qqqqzz").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_finds_related_words_after_the_typed_ones() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-related-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = worker(&dir);
        let c = &w.conn;
        for (i, t) in ["lab rat", "mouse", "hamster", "rate constant", "thrombocyte", "platelet aggregation"].iter().enumerate() {
            c.execute(
                &format!("INSERT INTO assets ({TEST_COLS}) VALUES (?1, 'servier', 'Servier', ?2, '', '', '', '[]', 'CC', '', '', ?1, NULL, 1, 1)"),
                params![format!("s{i}"), t],
            )
            .unwrap();
        }
        c.execute_batch("INSERT INTO assets_fts(assets_fts) VALUES('rebuild');").unwrap();
        let rel = |q: &str| titles(w.search(q, &[], 10, IconSort::Relevance).unwrap());
        // The typed word first, then related animals; "rate" is not a rat.
        let mice = rel("mouse");
        assert_eq!(mice[0], "mouse");
        assert_eq!(mice.len(), 3);
        assert!(mice.contains(&"lab rat".into()) && mice.contains(&"hamster".into()));
        assert_eq!(w.search_total("mice", &[]).unwrap(), 3);
        assert_eq!(rel("rats")[0], "lab rat");
        assert_eq!(rel("platelets")[0], "platelet aggregation");
        assert_eq!(rel("platelets").len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stars_come_from_the_catalog_until_the_worker_says_otherwise() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-stars-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = worker(&dir);
        // Opening an old catalog added the column; the published snapshot goes there.
        w.conn.execute("UPDATE assets SET stars = 1200 WHERE id = 'k2'", []).unwrap();
        let find = |w: &Worker, id: &str| w.browse("bioart", None, 0, 10, IconSort::Alphabetical).unwrap().into_iter().find(|r| r.id == id).unwrap();
        assert_eq!((find(&w, "k2").stars, find(&w, "k2").starred), (1200, false));
        assert_eq!((find(&w, "k0").stars, find(&w, "k0").starred), (0, false));
        // The latest counts reported (or the user's own click) win, in every query.
        w.set_stars(&[
            StarUpdate { id: "k2".into(), n: 1201, mine: true },
            StarUpdate { id: "k0".into(), n: 3, mine: false },
        ])
        .unwrap();
        assert_eq!((find(&w, "k2").stars, find(&w, "k2").starred), (1201, true));
        assert_eq!((find(&w, "k0").stars, find(&w, "k0").starred), (3, false));
        let hit = w.search("gamma", &[], 10, IconSort::Relevance).unwrap().remove(0);
        assert_eq!((hit.stars, hit.starred), (1201, true));
        let v = w.variants("k2").unwrap().remove(0);
        assert_eq!((v.stars, v.starred), (1201, true));
        // They live in the usage file, so they survive a catalog update.
        drop(w);
        let w = Worker::open(&dir.join("assets.sqlite"), &dir.join("usage.sqlite")).unwrap();
        assert_eq!((find(&w, "k0").stars, find(&w, "k0").starred), (3, false));
        // A read-only catalog without the column still opens; stars count as 0 there.
        drop(w);
        let plain = dir.join("plain.sqlite");
        Connection::open(&plain).unwrap().execute_batch("CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, title TEXT, variant TEXT, description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, png_key TEXT, png_local TEXT, png_width INTEGER, png_height INTEGER); INSERT INTO assets VALUES ('p', 'bioart', 'BioArt', 'plain', '', '', '', '[]', 'PD', '', '', 'p', NULL, 1, 1);").unwrap();
        let w = Worker::open_readonly(&plain, &dir.join("usage.sqlite")).unwrap();
        assert!(!w.stars_col);
        assert_eq!(find(&w, "p").stars, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn categories_split_and_totals_count_every_match() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-cats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = worker(&dir);
        for (id, cat, title) in [("v1", "Viruses, Molecules", "SARS-CoV-2"), ("v2", "Viruses", "Influenza"), ("u1", "", "Mystery")] {
            w.conn
                .execute(
                    &format!("INSERT INTO assets ({TEST_COLS}) VALUES (?1, 'bioart', 'BioArt', ?2, '', '', ?3, '[]', 'PD', '', '', ?1, NULL, 1, 1)"),
                    params![id, title, cat],
                )
                .unwrap();
        }
        w.conn.execute_batch("INSERT INTO assets_fts(assets_fts) VALUES('rebuild');").unwrap();
        let cats: Vec<(String, i64)> = w.categories("bioart").unwrap().into_iter().map(|c| (c.name, c.count)).collect();
        let want: Vec<(String, i64)> = [("cells", 4), ("Molecules", 1), ("Viruses", 2), ("", 1)].iter().map(|(n, c)| (n.to_string(), *c)).collect();
        assert_eq!(cats, want);
        assert_eq!(titles(w.browse("bioart", Some("Viruses"), 0, 10, IconSort::Alphabetical).unwrap()), ["Influenza", "SARS-CoV-2"]);
        assert_eq!(w.browse_total("bioart", Some("Molecules")).unwrap(), 1);
        assert_eq!(w.browse_total("bioart", Some("")).unwrap(), 1);
        assert_eq!(w.browse_total("bioart", None).unwrap(), 7);
        // Only 1 shown, but all 4 cells counted.
        assert_eq!(w.search("cell", &[], 1, IconSort::Relevance).unwrap().len(), 1);
        assert_eq!(w.search_total("cell", &[]).unwrap(), 4);
        assert_eq!(w.search_total("", &[]).unwrap(), 7);
        assert_eq!(w.search_total("", &["user".into()]).unwrap(), 0);

        let counts = w.taxonomy(&[]).unwrap();
        let n = |c: &str, s: &str| counts.iter().find(|t| t.cat == c && t.sub == s).map_or(0, |t| t.count);
        assert_eq!(n("", ""), 7);
        assert_eq!(n("Microbes and pathogens", "Viruses"), 2);
        assert_eq!(n("Other", ""), 1);
        let (rows, total) = w.browse_taxon(Some("Microbes and pathogens"), None, &[], 0, 10, IconSort::Alphabetical).unwrap();
        assert_eq!((titles(rows), total), (vec!["Influenza".to_string(), "SARS-CoV-2".to_string()], 2));
        let (_, total) = w.browse_taxon(None, None, &["user".into()], 0, 10, IconSort::Alphabetical).unwrap();
        assert_eq!(total, 0);
    }

    #[test]
    fn own_uploads_can_be_removed() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-remove-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = worker(&dir);
        // A published upload (no png_local) next to one of the user's own.
        for (id, local) in [("shared", None), ("mine", Some("/tmp/mine.png"))] {
            w.conn
                .execute(
                    &format!("INSERT INTO assets ({TEST_COLS}) VALUES (?1, 'user', 'User-generated', ?2, '', '', '', '[]', 'CC0-1.0', '', '', ?1, ?3, 1, 1)"),
                    params![format!("user/{id}"), format!("zebra {id}"), local],
                )
                .unwrap();
        }
        w.conn.execute_batch("INSERT INTO assets_fts(assets_fts) VALUES('rebuild');").unwrap();
        assert_eq!(w.search_total("zebra", &[]).unwrap(), 2);
        assert!(!w.remove_user("user/shared").unwrap());
        assert!(w.remove_user("user/mine").unwrap());
        assert!(!w.remove_user("user/mine").unwrap());
        assert_eq!(titles(w.search("zebra", &[], 10, IconSort::Relevance).unwrap()), vec!["zebra shared"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_rows_survive_a_catalog_that_gained_columns() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = worker(&dir);
        let c = &w.conn;
        c.execute(
            &format!("INSERT INTO assets ({TEST_COLS}) VALUES ('user/mine', 'user', 'User-generated', 'mine', '', '', '', '[]', 'CC0-1.0', '', '', 'user/mine.png', NULL, 1, 1)"),
            [],
        )
        .unwrap();
        c.execute_batch("INSERT INTO assets_fts(assets_fts) VALUES('rebuild');").unwrap();
        drop(w);
        // The old catalog (the test one) has no `stars`; the new one does, plus a column of its own.
        let new = dir.join("new.sqlite");
        Connection::open(&new)
            .unwrap()
            .execute_batch(
                "CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, title TEXT, variant TEXT, \
                 description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, png_key TEXT, \
                 png_local TEXT, png_width INTEGER, png_height INTEGER, stars INTEGER NOT NULL DEFAULT 0, newer TEXT); \
                 CREATE VIRTUAL TABLE assets_fts USING fts5(title, description, tags, category, variant, \
                 content='assets', content_rowid='rowid', tokenize='porter unicode61');",
            )
            .unwrap();
        // `worker()` opened the old catalog read-write, so it has `stars` by now; drop it to make
        // the column sets differ in both directions.
        Connection::open(dir.join("assets.sqlite")).unwrap().execute_batch("ALTER TABLE assets DROP COLUMN stars;").unwrap();
        copy_user_rows(&dir.join("assets.sqlite"), &new).unwrap();
        let w = Worker::open(&new, &dir.join("usage.sqlite")).unwrap();
        let rows = w.browse("user", None, 0, 10, IconSort::Alphabetical).unwrap();
        assert_eq!(titles(rows), vec!["mine"]);
        assert_eq!(titles(w.search("mine", &[], 10, IconSort::Alphabetical).unwrap()), vec!["mine"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An SVG the app keeps beside a user asset's PNG (an AI drawing) is stored, so it is drawn.
    #[test]
    fn user_rows_keep_their_svg() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-user-svg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("assets.sqlite");
        Connection::open(&db)
            .unwrap()
            .execute_batch(
                "CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, source_id TEXT, title TEXT, variant TEXT, \
                 description TEXT, category TEXT, tags TEXT, license TEXT, license_raw TEXT, license_url TEXT, \
                 attribution_required INTEGER, share_alike INTEGER, author TEXT, source_url TEXT, doi TEXT, credit TEXT, \
                 svg_key TEXT, png_key TEXT, png_is_raster INTEGER, png_width INTEGER, png_height INTEGER, svg_bytes INTEGER, \
                 png_bytes INTEGER, svg_local TEXT, png_local TEXT, extra TEXT, uploaded_at TEXT);",
            )
            .unwrap();
        let w = Worker::open(&db, &dir.join("usage.sqlite")).unwrap();
        let mut row = AssetRow {
            id: "user/drawn".into(),
            source: "user".into(),
            source_name: "User-generated".into(),
            title: "drawn".into(),
            variant: String::new(),
            category: String::new(),
            description: "one I drew".into(),
            license: "CC0-1.0".into(),
            credit: String::new(),
            author: String::new(),
            png_key: "user/drawn.png".into(),
            png_local: Some("/data/user_generated/drawn.png".into()),
            png_width: 4,
            png_height: 2,
            svg_key: Some("/data/user_generated/drawn.svg".into()),
            stars: 0,
            starred: false,
            taxa: Vec::new(),
        };
        w.insert_user(&row).unwrap();
        row.id = "user/painted".into();
        row.title = "painted".into();
        row.svg_key = None;
        w.insert_user(&row).unwrap();
        let rows = w.browse("user", None, 0, 10, IconSort::Alphabetical).unwrap();
        let svgs: Vec<_> = rows.iter().map(|r| (r.title.as_str(), r.svg_key.as_deref())).collect();
        assert_eq!(svgs, vec![("drawn", Some("/data/user_generated/drawn.svg")), ("painted", None)]);
        assert_eq!(rows[0].description, "one I drew");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_recolours_share_a_tile_and_pages_line_up() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-groups-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("assets.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, source_id TEXT, title TEXT, variant TEXT, \
             description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, png_key TEXT, \
             png_local TEXT, png_width INTEGER, png_height INTEGER, extra TEXT);",
        )
        .unwrap();
        let rows = [
            // One flask drawing in three colours, and another drawing with the same title.
            ("ba/1", "bioart", "1", "flask", "", r#"{"accession":"A1"}"#),
            ("ba/2", "bioart", "2", "flask", "red", r#"{"accession":"A1"}"#),
            ("ba/3", "bioart", "3", "flask", "blue", r#"{"accession":"A1"}"#),
            ("ba/4", "bioart", "4", "flask", "", r#"{"accession":"A2"}"#),
            // Two styles of one pictogram, and two drawings that share a title.
            ("hi/f", "healthicons", "filled/flask", "flask", "filled", "{}"),
            ("hi/o", "healthicons", "outline/flask", "flask", "outline", "{}"),
            ("sd/1", "scidraw", "x", "flask", "", "{}"),
            ("sd/2", "scidraw", "y", "flask", "", "{}"),
        ];
        for (id, source, sid, title, variant, extra) in rows {
            c.execute(
                "INSERT INTO assets VALUES (?1, ?2, ?2, ?3, ?4, ?5, '', 'lab', '[]', 'PD', '', '', ?1, NULL, 1, 1, ?6)",
                params![id, source, sid, title, variant, extra],
            )
            .unwrap();
        }
        drop(c);
        let w = Worker::open(&db, &dir.join("usage.sqlite")).unwrap();
        let ids = |rows: Vec<AssetRow>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        let all = ids(w.search("flask", &[], 100, IconSort::Relevance).unwrap());
        assert_eq!(all.len(), 6, "{all:?}");
        assert!(all.contains(&"ba/1".to_string()), "the plain colour stands for its drawing: {all:?}");
        assert_eq!(w.search_total("flask", &[]).unwrap(), 6);
        assert_eq!(w.search_total("", &[]).unwrap(), 6);
        assert_eq!(ids(w.search("", &[], 100, IconSort::Alphabetical).unwrap()).len(), 6);
        assert_eq!(ids(w.search("red flask", &[], 100, IconSort::Relevance).unwrap()), ["ba/2"]);
        for sort in IconSort::SEARCH {
            let whole = ids(w.search("flask", &[], 100, sort).unwrap());
            let mut paged = ids(w.search_page("flask", &[], None, 0, 4, sort).unwrap());
            paged.extend(ids(w.search_page("flask", &[], None, 4, 4, sort).unwrap()));
            assert_eq!(paged, whole, "{sort:?}");
        }
        assert_eq!(w.browse_total("bioart", None).unwrap(), 2);
        let re = w.recolors(&["ba/2".into(), "ba/4".into(), "hi/f".into()]).unwrap();
        assert_eq!(re.keys().collect::<Vec<_>>(), ["ba/2"]);
        let mut colours: Vec<&str> = re["ba/2"].iter().map(|r| r.variant.as_str()).collect();
        colours.sort();
        assert_eq!(colours, ["", "blue", "red"]);
        // Presets: a drawing's colours, a pictogram's styles, never another drawing's.
        assert_eq!(ids(w.variants("ba/2").unwrap()), ["ba/1", "ba/3", "ba/2"]);
        assert_eq!(ids(w.variants("ba/4").unwrap()), ["ba/4"]);
        assert_eq!(ids(w.variants("hi/o").unwrap()), ["hi/f", "hi/o"]);
        assert_eq!(ids(w.variants("sd/1").unwrap()), ["sd/1"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identical_copies_share_a_tile_but_keep_their_titles() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-dups-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("assets.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, title TEXT, variant TEXT, \
             description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, png_key TEXT, \
             png_local TEXT, png_width INTEGER, png_height INTEGER, extra TEXT, grp TEXT, dup INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        // As data/publish_catalog.py groups them: one bat listed under two accessions (the second
        // set copies), and a flag that another flag reuses.
        let rows = [
            ("ba/37_1", "bat", "", Some("ba/37_1"), 0),
            ("ba/37_2", "bat", "grey", Some("ba/37_1"), 0),
            ("ba/38_1", "bat", "", Some("ba/37_1"), 1),
            ("ba/38_2", "bat", "grey", Some("ba/37_1"), 1),
            ("om/au", "flag: Australia", "", Some("om/au"), 0),
            ("om/hm", "flag: Heard Island", "", Some("om/au"), 1),
            ("om/fr", "flag: France", "", None, 0),
        ];
        for (id, title, variant, grp, dup) in rows {
            c.execute(
                "INSERT INTO assets VALUES (?1, 'bioart', 'BioArt', ?2, ?3, '', '', '[]', 'PD', '', '', ?1, NULL, 1, 1, '{}', ?4, ?5)",
                params![id, title, variant, grp, dup],
            )
            .unwrap();
        }
        drop(c);
        let w = Worker::open(&db, &dir.join("usage.sqlite")).unwrap();
        let ids = |rows: Vec<AssetRow>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(w.search("bat", &[], 10, IconSort::Relevance).unwrap()), ["ba/37_1"]);
        assert_eq!(ids(w.search("", &[], 10, IconSort::Alphabetical).unwrap()), ["ba/37_1", "om/au", "om/fr"]);
        assert_eq!(w.search_total("", &[]).unwrap(), 3);
        // A copy's own title still finds it.
        assert_eq!(ids(w.search("heard", &[], 10, IconSort::Relevance).unwrap()), ["om/hm"]);
        let re = w.recolors(&["ba/38_1".into()]).unwrap();
        assert_eq!(ids(re["ba/38_1"].clone()), ["ba/37_1", "ba/37_2"]);
        // The icon a group is named after, the one search shows, has its colours too.
        let re = w.recolors(&["ba/37_1".into(), "om/fr".into()]).unwrap();
        assert_eq!(re.keys().collect::<Vec<_>>(), ["ba/37_1"]);
        assert_eq!(ids(re["ba/37_1"].clone()), ["ba/37_1", "ba/37_2"]);
        assert_eq!(ids(w.variants("ba/38_2").unwrap()), ["ba/37_1", "ba/37_2"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn biocartoons_own_uploads_are_listed_under_biocartoon_not_user_generated() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-own-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("assets.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, title TEXT, variant TEXT, \
             description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, png_key TEXT, \
             png_local TEXT, png_width INTEGER, png_height INTEGER, extra TEXT);",
        )
        .unwrap();
        for (id, source, author) in [("user/logo", "user", "BioCartoon"), ("user/cell", "user", "Ann"), ("bioicons/x", "bioicons", "")] {
            c.execute(
                "INSERT INTO assets VALUES (?1, ?2, 'User-generated', ?1, '', '', 'Lab', '[]', 'CC0-1.0', '', ?3, ?1, NULL, 1, 1, '{}')",
                params![id, source, author],
            )
            .unwrap();
        }
        drop(c);
        let w = Worker::open(&db, &dir.join("usage.sqlite")).unwrap();
        let ids = |rows: Vec<AssetRow>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(w.browse(BIOCARTOON_SOURCE, None, 0, 10, IconSort::Alphabetical).unwrap()), ["user/logo"]);
        assert_eq!(ids(w.browse("user", None, 0, 10, IconSort::Alphabetical).unwrap()), ["user/cell"]);
        assert_eq!((w.browse_total(BIOCARTOON_SOURCE, None).unwrap(), w.browse_total("user", Some("Lab")).unwrap()), (1, 1));
        assert_eq!(w.categories(BIOCARTOON_SOURCE).unwrap().iter().map(|c| c.count).sum::<i64>(), 1);
        assert_eq!(ids(w.search("", &["user".into()], 10, IconSort::Alphabetical).unwrap()), ["user/cell"]);
        assert_eq!(ids(w.search("", &[BIOCARTOON_SOURCE.into(), "bioicons".into()], 10, IconSort::Alphabetical).unwrap()), ["bioicons/x", "user/logo"]);
        let srcs: Vec<(String, String, i64)> = w.sources().unwrap().into_iter().map(|s| (s.source, s.name, s.icons)).collect();
        assert_eq!(srcs, [("biocartoon".into(), "BioCartoon".into(), 1), ("user".into(), "User-generated".into(), 1), ("bioicons".into(), "User-generated".into(), 1)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn filters_or_within_and_across() {
        let dir = std::env::temp_dir().join(format!("cc-catalog-filter-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("assets.sqlite");
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, source TEXT, source_name TEXT, title TEXT, variant TEXT, \
             description TEXT, category TEXT, tags TEXT, license TEXT, credit TEXT, author TEXT, png_key TEXT, \
             png_local TEXT, png_width INTEGER, png_height INTEGER);",
        )
        .unwrap();
        for (id, source, author, license, cat) in [
            ("a", "bioicons", "Ann Smith", "MIT", "Viruses, Cells"),
            ("b", "bioicons", "Bob", "CC0-1.0", "Cells"),
            ("c", "openmoji", "Joanna", "CC-BY-SA-4.0", "Cells"),
            ("d", "servier", "Servier", "MIT", ""),
        ] {
            c.execute(
                &format!("INSERT INTO assets ({TEST_COLS}) VALUES (?1, ?2, ?2, ?1, '', '', ?5, '[]', ?4, '', ?3, ?1, NULL, 1, 1)"),
                params![id, source, author, license, cat],
            )
            .unwrap();
        }
        c.execute_batch("ALTER TABLE assets ADD COLUMN svg_key TEXT; UPDATE assets SET svg_key = id || '.svg' WHERE id IN ('a', 'c');").unwrap();
        drop(c);
        let w = Worker::open(&db, &dir.join("usage.sqlite")).unwrap();
        let ids = |f: &Filter| {
            let rows = w.search_filtered("", f, 0, 10, IconSort::Alphabetical).unwrap();
            assert_eq!(w.search_filtered_total("", f).unwrap(), rows.len() as i64);
            rows.into_iter().map(|r| r.id).collect::<Vec<_>>()
        };
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        // Any part of the name, any case; several are any of them.
        assert_eq!(ids(&Filter { authors: s(&["ANN"]), ..Filter::default() }), ["a", "c"]);
        assert_eq!(ids(&Filter { authors: s(&["bob", "servier"]), ..Filter::default() }), ["b", "d"]);
        assert_eq!(ids(&Filter { sources: s(&["bioicons", "openmoji"]), ..Filter::default() }), ["a", "b", "c"]);
        // Across filters, all of them.
        assert_eq!(ids(&Filter { sources: s(&["bioicons"]), licenses: s(&["MIT"]), ..Filter::default() }), ["a"]);
        assert_eq!(ids(&Filter { sources: s(&["openmoji"]), licenses: s(&["MIT"]), ..Filter::default() }), Vec::<String>::new());
        // A category keeps what is filed under it; one with a subcategory picked keeps just that.
        let (cat, sub) = crate::taxonomy::classify("bioicons", "Cells", "b", "[]")[0];
        let by_cat = ids(&Filter { taxa: vec![(cat.into(), String::new())], ..Filter::default() });
        assert!(by_cat.contains(&"b".to_string()));
        assert_eq!(by_cat, ids(&Filter { taxa: vec![(cat.into(), sub.into())], ..Filter::default() }));
        assert_eq!(ids(&Filter { taxa: vec![(cat.into(), sub.into())], licenses: s(&["CC0-1.0"]), ..Filter::default() }), ["b"]);
        // A filter's choices are counted under the others, not under itself.
        let fc = w.facets("", &Filter { sources: s(&["bioicons"]), licenses: s(&["MIT"]), ..Filter::default() }).unwrap();
        assert_eq!(fc.licenses, [("CC0-1.0".to_string(), 1), ("MIT".to_string(), 1)]);
        assert_eq!(fc.sources, [("bioicons".to_string(), 1), ("servier".to_string(), 1)]);
        assert_eq!(fc.taxa.iter().find(|t| t.cat.is_empty()).map(|t| t.count), Some(1));
        // A database's own categories: one of several an asset is filed under, in that database only.
        let dc = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect::<Vec<_>>();
        assert_eq!(ids(&Filter { db_cats: dc(&[("bioicons", "Cells")]), ..Filter::default() }), ["a", "b"]);
        assert_eq!(ids(&Filter { db_cats: dc(&[("bioicons", "Viruses"), ("openmoji", "Cells")]), ..Filter::default() }), ["a", "c"]);
        let fc = w.facets("", &Filter { sources: s(&["bioicons"]), db_cats: dc(&[("bioicons", "Viruses")]), ..Filter::default() }).unwrap();
        assert_eq!(fc.db_cats, [("bioicons".to_string(), "Cells".to_string(), 2), ("bioicons".to_string(), "Viruses".to_string(), 1)]);
        // File type: an SVG when the source publishes one, else a PNG only; both keeps everything.
        assert_eq!(ids(&Filter { formats: s(&[FORMAT_SVG]), ..Filter::default() }), ["a", "c"]);
        assert_eq!(ids(&Filter { formats: s(&[FORMAT_PNG]), ..Filter::default() }), ["b", "d"]);
        assert_eq!(ids(&Filter { formats: s(&[FORMAT_SVG, FORMAT_PNG]), ..Filter::default() }), ["a", "b", "c", "d"]);
        let fc = w.facets("", &Filter { sources: s(&["bioicons"]), formats: s(&[FORMAT_SVG]), ..Filter::default() }).unwrap();
        assert_eq!(fc.formats, [("PNG".to_string(), 1), ("SVG".to_string(), 1)]);
        assert_eq!(fc.sources, [("bioicons".to_string(), 1), ("openmoji".to_string(), 1)]);
        // A query counts only what it finds.
        let fc = w.facets("cells", &Filter::default()).unwrap();
        assert_eq!(fc.sources, [("bioicons".to_string(), 2), ("openmoji".to_string(), 1)]);
        let fc = w.facets("cells", &Filter { licenses: s(&["MIT"]), ..Filter::default() }).unwrap();
        assert_eq!(fc.sources, [("bioicons".to_string(), 1)]);
        assert_eq!(fc.licenses, [("CC-BY-SA-4.0".to_string(), 1), ("CC0-1.0".to_string(), 1), ("MIT".to_string(), 1)]);
        assert!(w.facets("zzzz", &Filter::default()).unwrap().sources.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
