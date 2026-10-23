//! `bulk-download`: the published catalog in one folder. The metadata (the icon and template
//! catalogs, as SQLite, CSV, TSV, Excel or JSON), every icon (SVG or PNG) and every shared
//! template (its thumbnail, or a `.biocartoon` file the editor opens), with a README on what is
//! there, the licenses, and the shell commands that do the same; those commands are printed as
//! it goes. Files already in the folder are kept, so running it again fetches only what is missing.

use crate::cli::{utc, values, Args};
use crate::query::asset_base_url;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::io::IsTerminal;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
enum MetaExt {
    Sqlite,
    Csv,
    Tsv,
    Xlsx,
    Json,
}

impl MetaExt {
    fn ext(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::Csv => "csv",
            Self::Tsv => "tsv",
            Self::Xlsx => "xlsx",
            Self::Json => "json",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum TemplateExt {
    Png,
    Biocartoon,
}

/// What to download, from the options.
#[derive(Debug, PartialEq)]
struct Plan {
    metadata: bool,
    icons: bool,
    templates: bool,
    metadata_ext: MetaExt,
    /// Icons as SVG (a PNG when the source publishes none), or all as PNG.
    icons_svg: bool,
    templates_ext: TemplateExt,
    /// `--artwork-ext svg` with templates: they have no SVG, so they come as PNG thumbnails.
    templates_svg_fallback: bool,
    out: PathBuf,
    jobs: usize,
    limit: Option<usize>,
}

fn plan(a: &Args) -> Result<Plan, String> {
    let (mut metadata, mut icons, mut templates) = (false, false, false);
    let files: Vec<&str> = values(a, "files").flat_map(|v| v.split(',')).map(str::trim).filter(|v| !v.is_empty()).collect();
    for f in if files.is_empty() { vec!["all"] } else { files } {
        match f.to_lowercase().as_str() {
            "all" => (metadata, icons, templates) = (true, true, true),
            "metadata" => metadata = true,
            "artwork" => (icons, templates) = (true, true),
            "icons" => icons = true,
            "templates" => templates = true,
            _ => return Err(format!("--files is all, metadata, artwork, icons or templates, not {f:?}")),
        }
    }
    let ext = |k: &str| a.opt(k).map(|v| v.trim().to_lowercase());
    let metadata_ext = match ext("metadata-ext").as_deref() {
        None | Some("sqlite") => MetaExt::Sqlite,
        Some("csv") => MetaExt::Csv,
        Some("tsv") => MetaExt::Tsv,
        Some("xlsx") => MetaExt::Xlsx,
        Some("json") => MetaExt::Json,
        Some(v) => return Err(format!("--metadata-ext is sqlite, csv, tsv, xlsx or json, not {v:?}")),
    };
    let image = |k: &str| -> Result<Option<bool>, String> {
        match ext(k).as_deref() {
            None => Ok(None),
            Some("svg") => Ok(Some(true)),
            Some("png") => Ok(Some(false)),
            Some(v) => Err(format!("--{k} is png or svg, not {v:?}")),
        }
    };
    let artwork_svg = image("artwork-ext")?;
    let icons_svg = image("icons-ext")?.or(artwork_svg).unwrap_or(true);
    let (templates_ext, templates_svg_fallback) = match ext("templates-ext").as_deref() {
        Some("png") => (TemplateExt::Png, false),
        Some("biocartoon") => (TemplateExt::Biocartoon, false),
        Some("svg") => return Err("templates have no SVG; --templates-ext is png (the thumbnail) or biocartoon".into()),
        Some(v) => return Err(format!("--templates-ext is png or biocartoon, not {v:?}")),
        None => (TemplateExt::Png, templates && artwork_svg == Some(true)),
    };
    let limit = a.opt("limit").map(|v| v.parse::<usize>().map_err(|_| "--limit needs a number".to_string())).transpose()?;
    Ok(Plan {
        metadata,
        icons,
        templates,
        metadata_ext,
        icons_svg,
        templates_ext,
        templates_svg_fallback,
        out: PathBuf::from(a.opt("output-dir").unwrap_or("biocartoon-catalog")),
        jobs: a.num("jobs", 8)?.clamp(1, 32),
        limit,
    })
}

/// One file to fetch: `url` to `dest`, turned from `template.json` into a `.biocartoon` file
/// on the way when `biocartoon` is set.
struct Job {
    url: String,
    dest: PathBuf,
    biocartoon: bool,
}

/// How one folder's downloads went.
#[derive(Default)]
struct Tally {
    files: usize,
    /// Of `files`, how many were already there.
    kept: usize,
    bytes: u64,
    failed: Vec<String>,
}

struct Bulk {
    plan: Plan,
    base: String,
    agent: ureq::Agent,
    /// The commands printed so far, for the README.
    commands: Vec<String>,
}

pub fn run(a: &Args) -> Result<(), String> {
    let plan = plan(a)?;
    let base = asset_base_url().trim_end_matches('/').to_string();
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(120))).build().into();
    let mut b = Bulk { plan, base, agent, commands: Vec::new() };
    let out = b.plan.out.clone();
    std::fs::create_dir_all(&out).map_err(|e| format!("{}: {e}", out.display()))?;
    let started = Instant::now();
    let report = b.download();
    let readme = out.join("README.md");
    std::fs::write(&readme, b.readme(&report)).map_err(|e| format!("{}: {e}", readme.display()))?;
    if let Some(dir) = &report.scratch {
        let _ = std::fs::remove_dir_all(dir);
    }

    let failed: usize = report.folders.iter().map(|(_, t)| t.failed.len()).sum();
    if a.flag("json") {
        let folders: serde_json::Map<String, Value> = report
            .folders
            .iter()
            .map(|(name, t)| (name.to_string(), json!({"files": t.files, "already_there": t.kept, "bytes": t.bytes, "failed": t.failed})))
            .collect();
        crate::cli::print_json(&json!({"output_dir": out, "readme": readme, "folders": folders, "errors": report.errors}));
    } else {
        eprintln!();
        for (name, t) in &report.folders {
            let kept = if t.kept > 0 { format!(", {} already there", t.kept) } else { String::new() };
            let failed = if t.failed.is_empty() { String::new() } else { format!(", {} failed", t.failed.len()) };
            println!("{:<10} {:>6} files  {:>9}{kept}{failed}", format!("{name}/"), t.files, human_bytes(t.bytes));
        }
        println!("{} in {:.0} s; see {}", out.display(), started.elapsed().as_secs_f64(), readme.display());
    }
    if let Some(e) = report.errors.first() {
        return Err(e.clone());
    }
    if failed > 0 {
        return Err(format!("{failed} files could not be downloaded (listed in the README); run the same command again to fetch just those"));
    }
    Ok(())
}

/// What a run got: each folder's tally, the catalogs' versions, and errors that stopped a step.
#[derive(Default)]
struct Report {
    folders: Vec<(&'static str, Tally)>,
    assets_db: Option<PathBuf>,
    templates_db: Option<PathBuf>,
    version: String,
    templates_version: String,
    /// Icons asked for as SVG that came as PNG (their source publishes no SVG).
    png_fallbacks: usize,
    /// Templates without a thumbnail (left out of a PNG download).
    no_thumb: usize,
    errors: Vec<String>,
    /// The temporary folder the catalogs went to when they are not part of the download.
    scratch: Option<PathBuf>,
}

impl Bulk {
    /// Print `cmd` (a shell command doing what comes next) and keep it for the README.
    fn say(&mut self, cmd: impl Into<String>) {
        let cmd = cmd.into();
        eprintln!("$ {cmd}");
        self.commands.push(cmd);
    }

    fn download(&mut self) -> Report {
        let mut r = Report::default();
        let p = &self.plan;
        let (need_assets, need_templates) = (p.metadata || p.icons, p.metadata || p.templates);
        let keep_sqlite = p.metadata && p.metadata_ext == MetaExt::Sqlite;
        let meta_dir = self.plan.out.join("metadata");
        let db_dir = if keep_sqlite {
            meta_dir.clone()
        } else {
            let d = std::env::temp_dir().join(format!("biocartoon-bulk-{}", std::process::id()));
            r.scratch = Some(d.clone());
            d
        };
        if let Err(e) = std::fs::create_dir_all(&db_dir) {
            r.errors.push(format!("{}: {e}", db_dir.display()));
            return r;
        }

        let mut meta = Tally::default();
        for (need, table, file, version) in
            [(need_assets, "assets", "assets.sqlite", "version.txt"), (need_templates, "templates", "templates.sqlite", "templates_version.txt")]
        {
            if !need {
                continue;
            }
            let dest = db_dir.join(file);
            let v = format!("{}/catalog/{version}", self.base);
            self.say(format!("curl -fsSL {}", sh(&v)));
            let v = self.get(&v).map(|b| String::from_utf8_lossy(&b).trim().to_string()).unwrap_or_default();
            let url = format!("{}/catalog/{file}.gz", self.base);
            self.say(format!("curl -fsSL {} | gunzip > {}", sh(&url), sh(&dest.display().to_string())));
            match self.get_gz(&url, &dest) {
                Ok(n) if keep_sqlite => {
                    meta.files += 1;
                    meta.bytes += n;
                }
                Ok(_) => {}
                Err(e) => {
                    r.errors.push(e);
                    continue;
                }
            }
            if table == "assets" {
                (r.assets_db, r.version) = (Some(dest), v);
            } else {
                (r.templates_db, r.templates_version) = (Some(dest), v);
            }
        }

        if self.plan.metadata && self.plan.metadata_ext != MetaExt::Sqlite {
            for (db, table) in [(r.assets_db.clone(), "assets"), (r.templates_db.clone(), "templates")] {
                let Some(db) = db else { continue };
                match self.export(&db, table, &meta_dir) {
                    Ok(n) => {
                        meta.files += 1;
                        meta.bytes += n;
                    }
                    Err(e) => r.errors.push(e),
                }
            }
        }
        if self.plan.metadata {
            r.folders.push(("metadata", meta));
        }

        if self.plan.icons {
            if let Some(db) = r.assets_db.clone() {
                match self.icon_jobs(&db) {
                    Ok((jobs, fallbacks)) => {
                        r.png_fallbacks = fallbacks;
                        let t = self.fetch_all("icons", jobs);
                        r.folders.push(("icons", t));
                    }
                    Err(e) => r.errors.push(e),
                }
            }
        }
        if self.plan.templates {
            if let Some(db) = r.templates_db.clone() {
                match self.template_jobs(&db) {
                    Ok((jobs, no_thumb)) => {
                        r.no_thumb = no_thumb;
                        let t = self.fetch_all("templates", jobs);
                        r.folders.push(("templates", t));
                    }
                    Err(e) => r.errors.push(e),
                }
            }
        }
        r
    }

    /// GET `url`, retrying twice unless the server says the file isn't there.
    fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        let mut tries = 0;
        loop {
            tries += 1;
            let res = self.agent.get(url).call().and_then(|mut r| r.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec());
            match res {
                Ok(b) => return Ok(b),
                Err(ureq::Error::StatusCode(c)) if (400..500).contains(&c) => return Err(format!("{url}: HTTP {c}")),
                Err(e) if tries >= 3 => return Err(format!("{url}: {e}")),
                Err(_) => std::thread::sleep(Duration::from_millis(500 * tries)),
            }
        }
    }

    /// Download the gzipped `url` to `dest`, unpacked; returns the size written.
    fn get_gz(&self, url: &str, dest: &Path) -> Result<u64, String> {
        let mut res = self.agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
        let tmp = part(dest);
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        let n = std::io::copy(&mut flate2::read::GzDecoder::new(res.body_mut().as_reader()), &mut f).map_err(|e| format!("{url}: {e}"))?;
        std::fs::rename(&tmp, dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        Ok(n)
    }

    /// Write `table` of `db` to `dir/<table>.<ext>` with each file's URL added; returns its size.
    fn export(&mut self, db: &Path, table: &str, dir: &Path) -> Result<u64, String> {
        let ext = self.plan.metadata_ext;
        let base = self.base.replace('\'', "''");
        let url = |key: &str| format!("CASE WHEN coalesce({key}, '') = '' THEN NULL ELSE '{base}/' || {key} END AS {}", key.replace("_key", "_url"));
        let sql = match table {
            "assets" => format!("SELECT *, {}, {} FROM assets ORDER BY id", url("png_key"), url("svg_key")),
            _ => format!("SELECT *, {}, {} FROM templates ORDER BY id", url("json_key"), url("thumb_key")),
        };
        let dest = dir.join(format!("{table}.{}", ext.ext()));
        let (db_s, dest_s) = (sh(&db.display().to_string()), sh(&dest.display().to_string()));
        match ext {
            MetaExt::Csv => self.say(format!("sqlite3 -header -csv {db_s} {} > {dest_s}", sh(&sql))),
            MetaExt::Tsv => self.say(format!("sqlite3 -header -tabs {db_s} {} > {dest_s}", sh(&sql))),
            MetaExt::Json => self.say(format!("sqlite3 -json {db_s} {} > {dest_s}", sh(&sql))),
            _ => self.say(format!("sqlite3 -header -csv {db_s} {}  # the same rows, written as an Excel sheet: {dest_s}", sh(&sql))),
        }
        let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| format!("{}: {e}", db.display()))?;
        let mut st = conn.prepare(&sql).map_err(|e| format!("{table}: {e}"))?;
        let cols: Vec<String> = st.column_names().iter().map(|c| c.to_string()).collect();
        let mut rows = Vec::new();
        let mut q = st.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = q.next().map_err(|e| e.to_string())? {
            let mut out = Vec::with_capacity(cols.len());
            for i in 0..cols.len() {
                out.push(match row.get_ref(i).map_err(|e| e.to_string())? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                    ValueRef::Blob(b) => Value::String(format!("<blob {} bytes>", b.len())),
                });
            }
            rows.push(out);
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        match ext {
            MetaExt::Csv => std::fs::write(&dest, delimited(&cols, &rows, b',')),
            MetaExt::Tsv => std::fs::write(&dest, delimited(&cols, &rows, b'\t')),
            MetaExt::Json => std::fs::write(&dest, json_rows(&cols, &rows)),
            _ => return write_xlsx(&dest, table, &cols, &rows).and_then(|()| file_len(&dest)),
        }
        .map_err(|e| format!("{}: {e}", dest.display()))?;
        file_len(&dest)
    }

    /// The icon files to fetch, and how many of them are PNGs standing in for a missing SVG.
    fn icon_jobs(&mut self, db: &Path) -> Result<(Vec<Job>, usize), String> {
        let key = if self.plan.icons_svg { "coalesce(svg_key, png_key)" } else { "png_key" };
        let limit = self.plan.limit.map_or(String::new(), |n| format!(" LIMIT {n}"));
        let sql = format!("SELECT {key}, svg_key IS NULL FROM assets WHERE png_key IS NOT NULL ORDER BY id{limit}");
        let dir = self.plan.out.join("icons");
        self.say(format!(
            "sqlite3 {} {} | xargs -P {} -I{{}} curl -fsS --create-dirs -o {} {}",
            sh(&db.display().to_string()),
            sh(&sql.replace(", svg_key IS NULL", "")),
            self.plan.jobs,
            sh(&format!("{}/{{}}", dir.display())),
            sh(&format!("{}/{{}}", self.base)),
        ));
        let rows: Vec<(String, bool)> = query(db, &sql, |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)))?;
        let fallbacks = if self.plan.icons_svg { rows.iter().filter(|(_, png_only)| *png_only).count() } else { 0 };
        let jobs = rows
            .into_iter()
            .filter_map(|(key, _)| safe_join(&dir, &key).map(|dest| Job { url: format!("{}/{key}", self.base), dest, biocartoon: false }))
            .collect();
        Ok((jobs, fallbacks))
    }

    /// The template files to fetch, and how many templates have no thumbnail (when that is what
    /// is fetched).
    fn template_jobs(&mut self, db: &Path) -> Result<(Vec<Job>, usize), String> {
        let png = self.plan.templates_ext == TemplateExt::Png;
        let limit = self.plan.limit.map_or(String::new(), |n| format!(" LIMIT {n}"));
        let dir = self.plan.out.join("templates");
        let (key, ext) = if png { ("thumb_key", "png") } else { ("json_key", "biocartoon") };
        let sql = format!("SELECT {key}, id FROM templates WHERE coalesce({key}, '') <> '' ORDER BY id{limit}");
        let get = format!("curl -fsS \"{}/$key\"", esc(&self.base));
        let save = format!("\"{}/$id.{ext}\"", esc(&dir.display().to_string()));
        let fetch = if png {
            format!("{get} -o {save}")
        } else {
            // The editor's `.biocartoon` is a document: the template's one slide on its page.
            format!(
                "{get} | jq '{{title: .meta.title, slides: [.slide], width, height, unit: (if .width % 96 == 0 and .height % 96 == 0 then \"Inch\" else \"Px\" end), background, next_id: (([.slide.items[].id] | max // 0) + 1), guides: []}}' > {save}"
            )
        };
        self.say(format!("mkdir -p {}", sh(&dir.display().to_string())));
        self.say(format!("sqlite3 -separator ' ' {} {} | while read key id; do {fetch}; done", sh(&db.display().to_string()), sh(&sql)));
        let rows: Vec<(String, String)> = query(db, &sql, |r| Ok((r.get(0)?, r.get(1)?)))?;
        let all: usize = query(db, "SELECT count(*) FROM templates", |r| r.get::<_, i64>(0))?.first().copied().unwrap_or(0) as usize;
        let no_thumb = if png { all.min(self.plan.limit.unwrap_or(usize::MAX)).saturating_sub(rows.len()) } else { 0 };
        let jobs = rows
            .into_iter()
            .map(|(key, id)| Job { url: format!("{}/{key}", self.base), dest: dir.join(format!("{}.{ext}", file_stem(&id))), biocartoon: !png })
            .collect();
        Ok((jobs, no_thumb))
    }

    /// Fetch `jobs` on `--jobs` threads, keeping files already there, with a progress line on a
    /// terminal.
    fn fetch_all(&self, label: &str, jobs: Vec<Job>) -> Tally {
        let (next, done, kept, bytes) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0), AtomicU64::new(0));
        let failed = Mutex::new(Vec::new());
        let tty = std::io::stderr().is_terminal();
        let total = jobs.len();
        std::thread::scope(|s| {
            for _ in 0..self.plan.jobs.min(total.max(1)) {
                s.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(job) = jobs.get(i) else { break };
                    match std::fs::metadata(&job.dest) {
                        Ok(m) if m.len() > 0 => {
                            kept.fetch_add(1, Ordering::Relaxed);
                            bytes.fetch_add(m.len(), Ordering::Relaxed);
                        }
                        _ => match self.fetch_one(job) {
                            Ok(n) => {
                                bytes.fetch_add(n, Ordering::Relaxed);
                            }
                            Err(e) => failed.lock().unwrap().push(e),
                        },
                    }
                    done.fetch_add(1, Ordering::Relaxed);
                });
            }
            let line = || {
                let f = failed.lock().unwrap().len();
                let f = if f > 0 { format!(", {f} failed") } else { String::new() };
                format!("{label}: {}/{total}, {}{f}", done.load(Ordering::Relaxed), human_bytes(bytes.load(Ordering::Relaxed)))
            };
            while done.load(Ordering::Relaxed) < total {
                if tty {
                    eprint!("\r{}\x1b[K", line());
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            if tty {
                eprintln!("\r{}\x1b[K", line());
            } else {
                eprintln!("{}", line());
            }
        });
        let ok = total - failed.lock().unwrap().len();
        Tally { files: ok, kept: kept.into_inner(), bytes: bytes.into_inner(), failed: failed.into_inner().unwrap() }
    }

    fn fetch_one(&self, job: &Job) -> Result<u64, String> {
        let mut data = self.get(&job.url)?;
        if job.biocartoon {
            data = to_biocartoon(&data).map_err(|e| format!("{}: {e}", job.url))?;
        }
        if let Some(dir) = job.dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let tmp = part(&job.dest);
        std::fs::write(&tmp, &data).and_then(|()| std::fs::rename(&tmp, &job.dest)).map_err(|e| format!("{}: {e}", job.dest.display()))?;
        Ok(data.len() as u64)
    }

    fn readme(&self, r: &Report) -> String {
        let p = &self.plan;
        let mut s = String::from("# BioCartoon catalog download\n\n");
        let argv: Vec<String> = std::env::args().skip(1).map(|a| sh(&a)).collect();
        s.push_str(&format!("Downloaded {} from {} with `biocartoon {}`.\n", utc(std::time::SystemTime::now()), self.base, argv.join(" ")));
        let versions: Vec<String> = [("icon", &r.version), ("template", &r.templates_version)]
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| format!("{k} catalog version `{v}`"))
            .collect();
        if !versions.is_empty() {
            s.push_str(&format!("Published {}.\n", versions.join(", ")));
        }
        if let Some(n) = p.limit {
            s.push_str(&format!("\nOnly the first {n} icons and {n} templates (by id) were fetched (`--limit {n}`).\n"));
        }

        s.push_str("\n## Contents\n\n| Folder | What | Files | Size |\n|---|---|---|---|\n");
        for (name, t) in &r.folders {
            let what = match *name {
                "metadata" => format!("the icon and template catalogs, as {}", p.metadata_ext.ext()),
                "icons" if p.icons_svg => "every icon as an SVG (a PNG where its source publishes none)".into(),
                "icons" => "every icon as a PNG".into(),
                _ if p.templates_ext == TemplateExt::Png => "every shared slide template's thumbnail (PNG)".into(),
                _ => "every shared slide template as a `.biocartoon` file".into(),
            };
            s.push_str(&format!("| `{name}/` | {what} | {} | {} |\n", t.files, human_bytes(t.bytes)));
        }
        s.push_str("| `README.md` | this file | 1 | |\n");
        let missing: Vec<&str> = [("metadata", p.metadata), ("icons", p.icons), ("templates", p.templates)].iter().filter(|(_, on)| !on).map(|(n, _)| *n).collect();
        if !missing.is_empty() {
            s.push_str(&format!("\nNot part of this download: {} (`--files all` gets everything).\n", missing.join(", ")));
        }

        let failed: Vec<&String> = r.folders.iter().flat_map(|(_, t)| &t.failed).collect();
        if !r.errors.is_empty() || !failed.is_empty() {
            s.push_str("\n## Not downloaded\n\nRunning the same command again keeps what is here and retries these.\n\n");
            for e in r.errors.iter().chain(failed.iter().copied()).take(50) {
                s.push_str(&format!("- {e}\n"));
            }
            if failed.len() + r.errors.len() > 50 {
                s.push_str(&format!("- ... and {} more\n", failed.len() + r.errors.len() - 50));
            }
        }

        if let Some(db) = &r.assets_db {
            let sql = "SELECT source_name, count(*), replace(group_concat(DISTINCT license), ',', ', ') FROM assets \
                       WHERE png_key IS NOT NULL GROUP BY source_name ORDER BY count(*) DESC";
            if let Ok(rows) = query(db, sql, |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default()))) {
                s.push_str("\n## Collections\n\nIcons in the catalog");
                s.push_str(if p.limit.is_some() { " (not all of them were fetched)" } else { "" });
                s.push_str(":\n\n| Collection | Icons | Licenses |\n|---|---|---|\n");
                for (name, n, lic) in rows {
                    s.push_str(&format!("| {name} | {n} | {lic} |\n"));
                }
            }
        }

        s.push_str("\n## Files\n\n");
        if p.metadata {
            s.push_str(&match p.metadata_ext {
                MetaExt::Sqlite => "- `metadata/assets.sqlite`: the icon catalog (SQLite), one row per icon in the `assets` table. \
                     `metadata/templates.sqlite`: the template catalog, one row per template in `templates`. \
                     `assets_fts` is a full-text index over the icons' title, description, tags and category.\n"
                    .to_string(),
                ext => format!(
                    "- `metadata/assets.{e}` and `metadata/templates.{e}`: the `assets` (one row per icon) and `templates` \
                     (one row per template) tables, with the file URLs added as `png_url`/`svg_url` and `json_url`/`thumb_url`.{}\n",
                    match ext {
                        MetaExt::Tsv => " Tabs and line breaks inside a value are written as spaces.",
                        MetaExt::Xlsx => " Each is one sheet; a value longer than Excel's 32,767 characters is cut.",
                        _ => "",
                    },
                    e = ext.ext()
                ),
            });
            s.push_str(
                "  Columns of note: `title`, `tags` (a JSON array), `category`, `license`, `license_url`, `author`, \
                 `credit` (a ready-made attribution line), `source_url`, and `png_key`/`svg_key`, each file's path under \
                 the asset URL. Every column is described at https://github.com/josephrich98/biocartoon#database-structure\n",
            );
        }
        if p.icons {
            s.push_str("- `icons/<key>`: each icon at its path in the catalog, for example `icons/bioart/424_633913.");
            s.push_str(if p.icons_svg { "svg`. Its key is the `svg_key` column, or `png_key`" } else { "png`. Its key is the `png_key` column" });
            s.push_str(", so a file's row is `SELECT * FROM assets WHERE svg_key = '<key>' OR png_key = '<key>'`.");
            if r.png_fallbacks > 0 {
                s.push_str(&format!(
                    " {} icons are PNGs because their source publishes no SVG (Servier Medical Art and app uploads, among others).",
                    r.png_fallbacks
                ));
            }
            s.push('\n');
        }
        if p.templates {
            if p.templates_ext == TemplateExt::Png {
                s.push_str("- `templates/<id>.png`: each template's thumbnail; its row is `SELECT * FROM templates WHERE id = '<id>'`.");
                if p.templates_svg_fallback {
                    s.push_str(" (`--artwork-ext svg` was given; templates have no SVG, so these are PNGs.)");
                }
                if r.no_thumb > 0 {
                    s.push_str(&format!(" {} templates have no thumbnail and are left out.", r.no_thumb));
                }
                s.push_str(" `--templates-ext biocartoon` gets the templates themselves.\n");
            } else {
                s.push_str(
                    "- `templates/<id>.biocartoon`: each template as a one-slide BioCartoon document. Open it in the \
                     editor (File > Open, in the desktop app or at https://app.biocartoon.com); its icons load from \
                     the asset URL.\n",
                );
            }
        }

        s.push_str(
            "\n## Licenses and credit\n\n\
             Every icon keeps the license of the collection it came from (the `license` and `license_url` columns). \
             Where `attribution_required` is 1, credit the author with the ready-made `credit` line when you publish \
             a figure; where `share_alike` is 1, work that adapts the icon must use the same license. Templates carry \
             their own `license` and `author`, and the icons placed on them keep theirs.\n\n\
             ## How this was made\n\n\
             The same steps as shell commands (curl, gunzip, sqlite3, xargs and, for `.biocartoon` files, jq):\n\n```sh\n",
        );
        for c in &self.commands {
            s.push_str(c);
            s.push('\n');
        }
        s.push_str("```\n\n");
        if let Some(dir) = &r.scratch {
            s.push_str(&format!(
                "The catalogs went to a temporary folder ({}), deleted afterwards; `--files metadata` \
                 (with the default `--metadata-ext sqlite`) keeps them in `metadata/`.\n\n",
                dir.display()
            ));
        }
        s.push_str(
            "Running `biocartoon bulk-download` again with the same options into this folder keeps the files already \
             here and fetches only what is missing (the catalogs are always fetched again).\n",
        );
        s
    }
}

/// Every row of `sql` on `db`, through `f`.
fn query<T>(db: &Path, sql: &str, f: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>) -> Result<Vec<T>, String> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| format!("{}: {e}", db.display()))?;
    let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = st.query_map([], f).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// The editor's pixels per inch (`DPI` in the editor's doc.rs).
const DOC_DPI: f64 = 96.0;

/// A published `template.json` (metadata, page size and background, one slide) as a `.biocartoon`
/// file: a document with that one slide.
fn to_biocartoon(template: &[u8]) -> Result<Vec<u8>, String> {
    let t: Value = serde_json::from_slice(template).map_err(|e| format!("template: {e}"))?;
    let slide = t.get("slide").filter(|s| s.get("items").is_some_and(Value::is_array)).ok_or("template has no slide")?;
    let side = |k: &str| t.get(k).and_then(Value::as_f64).filter(|v| *v > 0.0).ok_or(format!("template has no {k}"));
    let (w, h) = (side("width")?, side("height")?);
    let next_id = slide["items"].as_array().into_iter().flatten().filter_map(|i| i["id"].as_u64()).max().unwrap_or(0) + 1;
    let inches = |v: f64| (v / DOC_DPI).fract() == 0.0;
    let doc = json!({
        "title": t["meta"]["title"].as_str().filter(|s| !s.is_empty()).unwrap_or("Template"),
        "slides": [slide],
        "width": w,
        "height": h,
        "unit": if inches(w) && inches(h) { "Inch" } else { "Px" },
        "background": t.get("background").cloned().unwrap_or(json!([255, 255, 255, 255])),
        "next_id": next_id,
        "guides": [],
    });
    serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())
}

/// `rows` as CSV (`sep` b',', quoting as RFC 4180) or TSV (b'\t'; tabs and line breaks in a value
/// become spaces), with a header row.
fn delimited(cols: &[String], rows: &[Vec<Value>], sep: u8) -> Vec<u8> {
    let cell = |s: &str| -> String {
        if sep == b'\t' {
            s.replace(['\t', '\r', '\n'], " ")
        } else if s.contains([',', '"', '\n', '\r']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };
    let text = |v: &Value| match v {
        Value::Null => String::new(),
        Value::String(s) => cell(s),
        o => o.to_string(),
    };
    let sep = (sep as char).to_string();
    let mut out = cols.iter().map(|c| cell(c)).collect::<Vec<_>>().join(&sep);
    out.push('\n');
    for r in rows {
        out.push_str(&r.iter().map(text).collect::<Vec<_>>().join(&sep));
        out.push('\n');
    }
    out.into_bytes()
}

/// `rows` as a JSON array of objects, keys in column order (as `sqlite3 -json` writes them).
fn json_rows(cols: &[String], rows: &[Vec<Value>]) -> Vec<u8> {
    let keys: Vec<String> = cols.iter().map(|c| Value::String(c.clone()).to_string()).collect();
    let objs: Vec<String> =
        rows.iter().map(|r| format!("{{{}}}", keys.iter().zip(r).map(|(k, v)| format!("{k}:{v}")).collect::<Vec<_>>().join(","))).collect();
    format!("[{}]\n", objs.join(",\n")).into_bytes()
}

/// Longest text an Excel cell holds.
const XLSX_MAX_CELL: usize = 32_767;

fn write_xlsx(dest: &Path, sheet: &str, cols: &[String], rows: &[Vec<Value>]) -> Result<(), String> {
    use rust_xlsxwriter::{Format, Workbook};
    let err = |e: rust_xlsxwriter::XlsxError| format!("{}: {e}", dest.display());
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name(sheet).map_err(err)?;
    let bold = Format::new().set_bold();
    for (c, name) in cols.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, name, &bold).map_err(err)?;
    }
    for (r, row) in rows.iter().enumerate() {
        let r = r as u32 + 1;
        for (c, v) in row.iter().enumerate() {
            let c = c as u16;
            match v {
                Value::Null => {}
                Value::Number(n) => {
                    ws.write_number(r, c, n.as_f64().unwrap_or_default()).map_err(err)?;
                }
                Value::String(s) if s.chars().count() > XLSX_MAX_CELL => {
                    ws.write_string(r, c, s.chars().take(XLSX_MAX_CELL).collect::<String>()).map_err(err)?;
                }
                Value::String(s) => {
                    ws.write_string(r, c, s).map_err(err)?;
                }
                o => {
                    ws.write_string(r, c, o.to_string()).map_err(err)?;
                }
            }
        }
    }
    if !cols.is_empty() {
        ws.set_freeze_panes(1, 0).map_err(err)?;
        ws.autofilter(0, 0, rows.len() as u32, cols.len() as u16 - 1).map_err(err)?;
    }
    wb.save(dest).map_err(err)
}

fn file_len(p: &Path) -> Result<u64, String> {
    std::fs::metadata(p).map(|m| m.len()).map_err(|e| format!("{}: {e}", p.display()))
}

/// `dest` with `.part` added: where a download goes until it is complete.
fn part(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// `dir/key` for a catalog key, or `None` for a key that would leave `dir` (`..`, absolute).
fn safe_join(dir: &Path, key: &str) -> Option<PathBuf> {
    let rel = Path::new(key);
    let ok = !key.is_empty() && !key.contains('\\') && rel.components().all(|c| matches!(c, Component::Normal(_)));
    ok.then(|| dir.join(rel))
}

/// A template id as a file name: letters, digits, `.`, `_` and `-` (anything else becomes `_`).
fn file_stem(id: &str) -> String {
    let s: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    s.trim_start_matches('.').to_string()
}

/// `s` as one shell word: as it is when that is safe, otherwise in double quotes.
fn sh(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-:=@%+,".contains(c)) {
        s.to_string()
    } else {
        format!("\"{}\"", esc(s))
    }
}

/// `s` escaped for the inside of a double-quoted shell string.
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`")
}

fn human_bytes(b: u64) -> String {
    match b {
        b if b >= 1 << 30 => format!("{:.1} GB", b as f64 / (1u64 << 30) as f64),
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / (1u64 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.0} KB", b as f64 / 1024.0),
        b => format!("{b} B"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Args {
        Args::parse(v.iter().map(|s| s.to_string()).collect(), &[])
    }

    #[test]
    fn plans_from_options() {
        let p = plan(&args(&["bulk-download"])).unwrap();
        assert!(p.metadata && p.icons && p.templates && p.icons_svg);
        assert_eq!((p.metadata_ext, p.templates_ext, p.out.clone()), (MetaExt::Sqlite, TemplateExt::Png, PathBuf::from("biocartoon-catalog")));

        let p = plan(&args(&["bulk-download", "--files", "artwork", "--artwork-ext", "png", "--output-dir", "x"])).unwrap();
        assert!(!p.metadata && p.icons && p.templates && !p.icons_svg && !p.templates_svg_fallback);
        assert_eq!(p.out, PathBuf::from("x"));

        let p = plan(&args(&["bulk-download", "--files=icons,metadata", "--artwork-ext", "svg", "--icons-ext", "png", "--metadata-ext", "XLSX"])).unwrap();
        assert!(p.metadata && p.icons && !p.templates && !p.icons_svg && !p.templates_svg_fallback);
        assert_eq!(p.metadata_ext, MetaExt::Xlsx);

        let p = plan(&args(&["bulk-download", "--files", "templates", "--artwork-ext", "svg"])).unwrap();
        assert!(p.templates_svg_fallback && p.templates_ext == TemplateExt::Png);
        let p = plan(&args(&["bulk-download", "--files", "templates", "--templates-ext", "biocartoon"])).unwrap();
        assert_eq!(p.templates_ext, TemplateExt::Biocartoon);

        for bad in [["--files", "pictures"], ["--metadata-ext", "xml"], ["--icons-ext", "jpg"], ["--templates-ext", "svg"], ["--limit", "ten"]] {
            assert!(plan(&args(&["bulk-download", bad[0], bad[1]])).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn template_becomes_a_document() {
        let t = br#"{"meta":{"title":"Cell"},"width":960,"height":672,"background":[1,2,3,255],
                     "slide":{"name":"s","items":[{"id":4},{"id":9}]}}"#;
        let d: Value = serde_json::from_slice(&to_biocartoon(t).unwrap()).unwrap();
        assert_eq!(d["title"], "Cell");
        assert_eq!(d["slides"][0]["name"], "s");
        assert_eq!((d["unit"].as_str(), d["next_id"].as_u64()), (Some("Inch"), Some(10)));
        assert_eq!(d["background"], json!([1, 2, 3, 255]));
        let odd = br#"{"meta":{},"width":1000,"height":672,"slide":{"name":"s","items":[]}}"#;
        let d: Value = serde_json::from_slice(&to_biocartoon(odd).unwrap()).unwrap();
        assert_eq!((d["unit"].as_str(), d["next_id"].as_u64(), d["title"].as_str()), (Some("Px"), Some(1), Some("Template")));
        assert!(to_biocartoon(br#"{"width":1,"height":1}"#).is_err());
    }

    #[test]
    fn writes_tables() {
        let cols = vec!["id".to_string(), "title".to_string(), "n".to_string()];
        let rows = vec![vec![json!("a/1"), json!("Say \"hi\", then\nleave"), json!(3)], vec![json!("a/2"), Value::Null, json!(1.5)]];
        assert_eq!(String::from_utf8(delimited(&cols, &rows, b',')).unwrap(), "id,title,n\na/1,\"Say \"\"hi\"\", then\nleave\",3\na/2,,1.5\n");
        assert_eq!(String::from_utf8(delimited(&cols, &rows, b'\t')).unwrap(), "id\ttitle\tn\na/1\tSay \"hi\", then leave\t3\na/2\t\t1.5\n");
        let j: Value = serde_json::from_slice(&json_rows(&cols, &rows)).unwrap();
        assert_eq!(j[0]["title"], "Say \"hi\", then\nleave");
        assert_eq!(j[1]["title"], Value::Null);
        assert!(String::from_utf8(json_rows(&cols, &rows)).unwrap().starts_with("[{\"id\":\"a/1\",\"title\""));

        let dir = std::env::temp_dir().join(format!("biocartoon-bulk-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let x = dir.join("t.xlsx");
        write_xlsx(&x, "assets", &cols, &rows).unwrap();
        assert!(std::fs::read(&x).unwrap().starts_with(b"PK"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_files_inside_and_quotes_commands() {
        let d = Path::new("out");
        assert_eq!(safe_join(d, "bioart/1.png"), Some(PathBuf::from("out/bioart/1.png")));
        for bad in ["../x.png", "/etc/x", "a/../../x", "", "a\\b"] {
            assert_eq!(safe_join(d, bad), None, "{bad}");
        }
        assert_eq!(file_stem("cell-5a1e/../x"), "cell-5a1e_.._x");
        assert_eq!(sh("out/icons/a.png"), "out/icons/a.png");
        assert_eq!(sh("SELECT '$x' FROM \"t\""), "\"SELECT '\\$x' FROM \\\"t\\\"\"");
    }
}
