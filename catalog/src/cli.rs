//! `biocartoon`: search the icon catalog from a shell, or serve it to an assistant over MCP.
//! The BioCartoon editor's own `biocartoon` runs these same commands through [`run_command`],
//! adding its templates to `search` and the `app` command.

use crate::catalog::{resolve_source, Filter, IconSort, FORMAT_PNG, FORMAT_SVG, SOURCES};
use crate::mcp;
use crate::query::{self, Asset, Catalog};
use crate::taxonomy;
use crate::upload;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

/// The catalog commands, for the usage text of any program that runs them.
pub const CATALOG_COMMANDS: &str = "\
COMMANDS
  search [TERM]             icons and templates matching TERM, best first (one per icon;
                            science collections first). An empty TERM pages through them all.
      --icons | --templates only icons, or only templates
      Icon filters. Repeat one for several values: an icon matching any of them passes. An icon
      has to pass every filter given.
      --source S            from a collection: a code or name from --sources
      --author A            by an author: part of the name, any case (ann finds Ann Smith)
      --category C          in a category: a slug from --categories (cells, or cells.cell_types)
      --subcategory S       in a subcategory: a slug from --categories (cell_types, cells.cell_types)
      --db-category [S:]C   in a collection's own category C, from --db-categories; S: limits
                            it to collection S (C alone: that category in any collection)
      --license L           under a license (CC-BY-4.0, CC0-1.0, ...; any case)
      --file-type svg|png   svg: published as SVG; png: published as a PNG only
      --limit N             how many of each (default 12)  [--offset N]
      --sort relevance|az|za|popular
      --columns C,C,...     which columns of the icon table to show, in this order (default all):
                            id, title, source, category, description, author, license, filetype
      --sql                 run TERM as read-only SQL on the catalog instead (no TERM: the schema)
                            [--max-rows N]. A TERM that starts like SQL (SELECT ... FROM, WITH,
                            PRAGMA, EXPLAIN) is run as SQL anyway, with a warning; --no-sql stops that.
  get <id>                  everything about one icon: license, credit, URLs, colour variants
  fetch <id>                download the PNG  [--svg] [--out FILE|DIR] [--max-side N] [--open]
  sync                      download the newest published catalog
  upload <file|folder>...   submit images (SVG, PNG, JPEG, WebP, GIF, BMP, TIFF; folders searched
                            recursively) to the shared library. They wait in the review queue
                            and join the catalog once approved; an SVG is published as SVG,
                            with a PNG rendered from it (no scripts, links or web fonts in it).
                            Up to 20 a day.
      --license L           CC0-1.0 or CC-BY-4.0 (required): you confirm you may share them so
      --credit NAME         who to credit (default anonymous)
      --title T             the name (default: from the file name; one file only)
      --description D  --category C   (C: a slug from --categories, or free text)
      --dry-run             check and list what would be submitted, without submitting
  --version                 this program's version, and when the catalog was published and downloaded
  --sources                 the collections: code, name, icons, licenses, what they hold
  --categories              BioCartoon's categories and subcategories, with slugs and counts
                            (of one collection with --source)
  --db-categories           the collections' own categories, with counts  [--source S]
";

/// The options every catalog command takes.
pub const CATALOG_OPTIONS: &str = "\
OPTIONS
  --json                    machine-readable output
  --db PATH                 catalog file (default: the copy shared with the editor; env BIOCARTOON_DB)
  --url URL                 asset base URL (env BIOCARTOON_ASSET_URL)
  --submit-url URL          submissions server for upload (env BIOCARTOON_SUBMIT_URL)
";

fn usage() -> String {
    format!(
        "biocartoon — search the BioCartoon icon catalog\n\nUSAGE\n  biocartoon <command> [arguments] [options]\n\n{CATALOG_COMMANDS}\n\
         ASSISTANTS\n  mcp                       serve the catalog tools over MCP on stdin/stdout:\n                              claude mcp add biocartoon -- biocartoon mcp\n\n\
         Templates and the `app` command come with the BioCartoon editor's own `biocartoon`.\n\n{CATALOG_OPTIONS}"
    )
}

/// Command-line arguments: positionals, and `--flag` / `--key value` / `--key=value` options.
pub struct Args {
    pub pos: Vec<String>,
    pub opts: HashMap<String, Vec<String>>,
}

impl Args {
    /// `valued` names the options that take a value (the catalog's are always included).
    pub fn parse(argv: Vec<String>, valued: &[&str]) -> Self {
        const VALUED: [&str; 20] = [
            "source", "limit", "sort", "category", "offset", "out", "max-side", "max-rows", "db", "url", "license", "credit", "title",
            "description", "submit-url", "author", "subcategory", "db-category", "file-type", "columns",
        ];
        let mut a = Self { pos: Vec::new(), opts: HashMap::new() };
        let mut it = argv.into_iter();
        while let Some(x) = it.next() {
            if let Some(flag) = x.strip_prefix("--") {
                let (k, v) = match flag.split_once('=') {
                    Some((k, v)) => (k.to_string(), Some(v.to_string())),
                    None if VALUED.contains(&flag) || valued.contains(&flag) => (flag.to_string(), it.next()),
                    None => (flag.to_string(), None),
                };
                a.opts.entry(k).or_default().extend(v);
            } else {
                a.pos.push(x);
            }
        }
        a
    }
    pub fn flag(&self, k: &str) -> bool {
        self.opts.contains_key(k)
    }
    pub fn opt(&self, k: &str) -> Option<&str> {
        self.opts.get(k).and_then(|v| v.last()).map(String::as_str)
    }
    pub fn num(&self, k: &str, default: usize) -> Result<usize, String> {
        self.opt(k).map_or(Ok(default), |v| v.parse().map_err(|_| format!("--{k} needs a number")))
    }
    pub fn rest(&self, from: usize) -> String {
        self.pos.iter().skip(from).cloned().collect::<Vec<_>>().join(" ")
    }
    /// The command (first positional), `help` when there is none.
    pub fn command(&self) -> &str {
        self.pos.first().map(String::as_str).unwrap_or("help")
    }
    /// `--help`, `help` or no command at all (except a lone `--sources`, `--categories`,
    /// `--db-categories` or `--version`).
    pub fn wants_help(&self) -> bool {
        self.flag("help")
            || (matches!(self.command(), "help" | "-h")
                && !["sources", "categories", "db-categories", "version"].iter().any(|f| self.flag(f)))
    }
    /// `--db`, `--url` and `--submit-url` become `BIOCARTOON_DB`, `BIOCARTOON_ASSET_URL` and
    /// `BIOCARTOON_SUBMIT_URL` for the rest of the run.
    pub fn apply_env(&self) {
        if let Some(db) = self.opt("db") {
            std::env::set_var("BIOCARTOON_DB", db);
        }
        if let Some(url) = self.opt("url") {
            std::env::set_var("BIOCARTOON_ASSET_URL", url);
        }
        if let Some(url) = self.opt("submit-url") {
            std::env::set_var("BIOCARTOON_SUBMIT_URL", url);
        }
    }
}

pub fn print_json(v: &impl serde::Serialize) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

/// The columns of `search`'s icon table, in order, with what fills them. `--columns` picks some.
const ICON_COLUMNS: [(&str, fn(&Asset) -> String); 8] = [
    ("ID", |a| a.id.clone()),
    ("Title", |a| if a.variant.is_empty() { a.title.clone() } else { format!("{} [{}]", a.title, a.variant) }),
    ("Source", |a| a.source.clone()),
    ("Category", |a| a.category.clone()),
    ("Description", |a| a.description.clone()),
    ("Author", |a| a.author.clone()),
    ("License", |a| a.license.clone()),
    ("File type", |a| if a.svg_key.is_some() { FORMAT_SVG } else { FORMAT_PNG }.to_string()),
];

/// The `--columns` given (comma-separated, any case, repeatable) as indices into
/// [`ICON_COLUMNS`], in the order given; all of them when there's no `--columns`.
fn icon_columns(a: &Args) -> Result<Vec<usize>, String> {
    let key = |s: &str| s.to_lowercase().replace(['-', '_', ' '], "");
    let mut cols = Vec::new();
    for name in values(a, "columns").flat_map(|v| v.split(',')).map(str::trim).filter(|n| !n.is_empty()) {
        let i = ICON_COLUMNS.iter().position(|(c, _)| key(c) == key(name)).ok_or_else(|| {
            let known = ICON_COLUMNS.iter().map(|(c, _)| key(c)).collect::<Vec<_>>().join(", ");
            format!("unknown column {name:?} (one of {known})")
        })?;
        if !cols.contains(&i) {
            cols.push(i);
        }
    }
    Ok(if cols.is_empty() { (0..ICON_COLUMNS.len()).collect() } else { cols })
}

fn print_assets(rows: &[Asset], cols: &[usize]) {
    if rows.is_empty() {
        println!("no results");
        return;
    }
    let head: Vec<&str> = cols.iter().map(|&i| ICON_COLUMNS[i].0).collect();
    let body: Vec<Vec<String>> = rows.iter().map(|a| cols.iter().map(|&i| (ICON_COLUMNS[i].1)(a)).collect()).collect();
    print_table(&head, &body);
    let n = rows.len();
    println!("{n} result{}. Pass an ID to `biocartoon get <ID>` for its license and credit, or `biocartoon fetch <ID>` to download it.", if n == 1 { "" } else { "s" });
}

/// Templates a program adds to `search` (the editor's): JSON objects with at least `id`,
/// `title`, `description` and `category`, filtered by the search term.
pub type Templates<'a> = &'a dyn Fn(&str) -> Vec<Value>;

fn print_templates(rows: &[Value]) {
    if rows.is_empty() {
        println!("no results");
        return;
    }
    let s = |t: &Value, k: &str| t[k].as_str().unwrap_or_default().to_string();
    let body: Vec<Vec<String>> = rows.iter().map(|t| vec![s(t, "id"), s(t, "title"), s(t, "category"), s(t, "description")]).collect();
    print_table(&["ID", "Title", "Category", "Description"], &body);
}

/// Longest a cell other than an ID (which is never cut) is shown, in characters.
const MAX_CELL: usize = 48;

/// Print `rows` as a table with box-drawing lines and a header row.
fn print_table(head: &[&str], rows: &[Vec<String>]) {
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|r| r.iter().zip(head).map(|(c, h)| if *h == "ID" { c.clone() } else { clip(&one_line(c), MAX_CELL) }).collect())
        .collect();
    let width = |i: usize| cells.iter().map(|r| r[i].chars().count()).chain([head[i].chars().count()]).max().unwrap_or(0);
    let widths: Vec<usize> = (0..head.len()).map(width).collect();
    let rule = |l: &str, m: &str, r: &str| {
        let segs: Vec<String> = widths.iter().map(|w| "─".repeat(w + 2)).collect();
        println!("{l}{}{r}", segs.join(m));
    };
    let line = |row: &[String]| {
        let segs: Vec<String> = row.iter().zip(&widths).map(|(c, w)| format!(" {c}{} ", " ".repeat(w - c.chars().count()))).collect();
        println!("│{}│", segs.join("│"));
    };
    rule("┌", "┬", "┐");
    line(&head.iter().map(|h| h.to_string()).collect::<Vec<_>>());
    rule("├", "┼", "┤");
    for r in &cells {
        line(r);
    }
    rule("└", "┴", "┘");
}

/// `s` with each run of whitespace (newlines too) turned into one space.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `s` cut to `max` characters, ending in an ellipsis when cut.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// Open `path` in the system's default app for its type.
fn open_file(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(path).spawn().map(drop).map_err(|e| format!("open {}: {e}", path.display()))
}

/// Whether a search term reads as a SQL statement rather than words.
pub fn looks_like_sql(term: &str) -> bool {
    let words: Vec<String> = term.split_whitespace().map(str::to_lowercase).collect();
    match words.first().map(String::as_str) {
        Some("select") => words.len() > 2 && words.iter().any(|w| w == "from"),
        Some("with") => words.iter().any(|w| w == "select"),
        Some("pragma" | "explain") => words.len() > 1,
        _ => false,
    }
}

/// Run one of the [`CATALOG_COMMANDS`]; `None` when `a` names another command. `templates`
/// joins `search` when there are any.
pub fn run_command(a: &Args, templates: Option<Templates>) -> Option<Result<(), String>> {
    if a.flag("sources") {
        return Some(sources(a));
    }
    if a.flag("categories") {
        return Some(categories(a));
    }
    if a.flag("db-categories") {
        return Some(db_categories(a));
    }
    let cmd = a.command();
    const NAMES: [&str; 6] = ["sync", "search", "get", "fetch", "upload", "help"];
    NAMES.contains(&cmd).then(|| run_inner(a, cmd, templates))
}

/// `--source` values as source keys.
fn source_args(a: &Args) -> Result<Vec<String>, String> {
    a.opts
        .get("source")
        .into_iter()
        .flatten()
        .map(|s| resolve_source(s).map(String::from).ok_or_else(|| format!("unknown source {s:?} (see biocartoon --sources)")))
        .collect()
}

/// Every value given for option `k`.
fn values<'a>(a: &'a Args, k: &str) -> impl Iterator<Item = &'a str> {
    a.opts.get(k).into_iter().flatten().map(String::as_str)
}

/// The icon filter options of `search`.
const ICON_FILTERS: [&str; 7] = ["source", "author", "category", "subcategory", "db-category", "license", "file-type"];

/// `search`'s icon filter. Each option keeps the icons matching any of its values, and an icon
/// has to pass every option given. `None` when they can't match anything (subcategories outside
/// every `--category`).
fn icon_filter(a: &Args, cat: &Catalog) -> Result<Option<Filter>, String> {
    let mut f = Filter { sources: source_args(a)?, ..Filter::default() };
    f.authors = values(a, "author").map(str::to_string).collect();

    let mut cats = Vec::new();
    for c in values(a, "category") {
        cats.push(taxonomy::resolve(c).ok_or_else(|| format!("unknown category {c:?} (see biocartoon --categories)"))?);
    }
    let mut subs = Vec::new();
    for s in values(a, "subcategory") {
        let found = taxonomy::resolve_subcategories(s);
        if found.is_empty() {
            return Err(format!("unknown subcategory {s:?} (see biocartoon --categories)"));
        }
        subs.extend(found);
    }
    // Both: the subcategories inside the categories (or the same subcategory `--category` named).
    let taxa = if subs.is_empty() {
        cats
    } else if cats.is_empty() {
        subs
    } else {
        let inside: Vec<_> = subs.into_iter().filter(|(c, s)| cats.iter().any(|(kc, ks)| kc == c && (ks.is_empty() || ks == s))).collect();
        if inside.is_empty() {
            return Ok(None);
        }
        inside
    };
    f.taxa = taxa.into_iter().map(|(c, s)| (c.to_string(), s.to_string())).collect();

    if a.flag("license") || a.flag("db-category") {
        let facets = cat.facets(&Filter::default())?;
        for l in values(a, "license") {
            let found = facets.licenses.iter().find(|(name, _)| name.eq_ignore_ascii_case(l.trim()));
            let known = || facets.licenses.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ");
            f.licenses.push(found.ok_or_else(|| format!("unknown license {l:?} (one of {})", known()))?.0.clone());
        }
        for v in values(a, "db-category") {
            let (src, c) = match v.split_once(':') {
                Some((s, c)) => (Some(resolve_source(s.trim()).ok_or_else(|| format!("unknown source {s:?} (see biocartoon --sources)"))?), c.trim()),
                None => (None, v.trim()),
            };
            let found: Vec<_> = facets
                .db_cats
                .iter()
                .filter(|(s, name, _)| src.is_none_or(|src| src == s) && name.eq_ignore_ascii_case(c))
                .map(|(s, name, _)| (s.clone(), name.clone()))
                .collect();
            if found.is_empty() {
                return Err(format!("no collection has the category {v:?} (see biocartoon --db-categories)"));
            }
            f.db_cats.extend(found);
        }
    }

    for t in values(a, "file-type") {
        f.formats.push(match t.trim().to_lowercase().as_str() {
            "svg" => FORMAT_SVG.to_string(),
            "png" => FORMAT_PNG.to_string(),
            _ => return Err(format!("--file-type is svg or png, not {t:?}")),
        });
    }
    Ok(Some(f))
}

fn sources(a: &Args) -> Result<(), String> {
    let cat = Catalog::open_default()?;
    let info: HashMap<String, (i64, String)> = cat.sources()?.into_iter().map(|s| (s.source, (s.icons, s.licenses))).collect();
    let mut rows = Vec::new();
    for (key, code, name, about) in SOURCES {
        // Drawings, as the README counts them; BioCartoon's own are a subset of the uploads.
        let icons = match info.get(*key) {
            Some((n, _)) => *n,
            None => cat.source_total(key)?,
        };
        if icons > 0 {
            let lic = info.get(*key).or_else(|| info.get("user").filter(|_| *key == crate::catalog::BIOCARTOON_SOURCE));
            rows.push(json!({"code": code, "source": key, "name": name, "icons": icons, "licenses": lic.map(|(_, l)| l.clone()).unwrap_or_default(), "description": about}));
        }
    }
    if a.flag("json") {
        print_json(&rows);
    } else {
        for r in &rows {
            let s = |k: &str| r[k].as_str().unwrap_or_default().to_string();
            println!("{:<3} {:<12} {:<22} {:>6}  {}", s("code"), s("source"), s("name"), r["icons"], s("licenses"));
            println!("{:39}{}", "", s("description"));
        }
    }
    Ok(())
}

fn categories(a: &Args) -> Result<(), String> {
    let counts: HashMap<(String, String), i64> =
        Catalog::open_default()?.taxonomy(&source_args(a)?)?.into_iter().map(|t| ((t.cat, t.sub), t.count)).collect();
    let count = |c: &str, s: &str| counts.get(&(c.to_string(), s.to_string())).copied().unwrap_or(0);
    let mut rows = Vec::new();
    for (c, subs) in taxonomy::TAXONOMY {
        for s in std::iter::once(&"").chain(subs.iter()) {
            let name = if s.is_empty() { c } else { s };
            rows.push(json!({"slug": taxonomy::taxon_slug(c, s), "name": name, "icons": count(c, s), "description": taxonomy::about(name)}));
        }
    }
    if a.flag("json") {
        print_json(&rows);
    } else {
        for r in &rows {
            let slug = r["slug"].as_str().unwrap_or_default();
            let indent = if slug.contains('.') { "  " } else { "" };
            println!("{:<58} {:>6}  {}", format!("{indent}{slug}"), r["icons"], r["description"].as_str().unwrap_or_default());
        }
    }
    Ok(())
}

fn run_inner(a: &Args, cmd: &str, templates: Option<Templates>) -> Result<(), String> {
    let json = a.flag("json");
    let catalog = Catalog::open_default;
    match cmd {
        "sync" => {
            let p = query::ensure_catalog(true, |b| eprintln!("downloading... {:.1} MB", b as f64 / 1e6))?;
            println!("catalog: {}", p.display());
        }
        "search" => {
            let q = a.rest(1);
            let sql = a.flag("sql")
                || (!a.flag("no-sql") && looks_like_sql(&q) && {
                    eprintln!("warning: running the search term as SQL; pass --no-sql to search for the words instead");
                    true
                });
            if sql {
                return run_sql(a, &q);
            }
            search(a, &q, templates)?;
        }
        "get" => {
            let id = a.pos.get(1).ok_or("get <id>")?;
            let cat = catalog()?;
            let asset = cat.get(id)?.ok_or_else(|| format!("no asset {id}"))?;
            let variants: Vec<String> = cat.variants(id)?.into_iter().map(|v| v.id).filter(|v| v != id).collect();
            let mut v = serde_json::to_value(&asset).unwrap_or_default();
            v["variants"] = json!(variants);
            if json {
                print_json(&v);
            } else {
                for (k, v) in v.as_object().into_iter().flatten() {
                    let shown = match v {
                        Value::String(s) => s.clone(),
                        Value::Array(a) => a.iter().map(|x| x.as_str().map_or_else(|| x.to_string(), String::from)).collect::<Vec<_>>().join(", "),
                        other => other.to_string(),
                    };
                    println!("{k:<14} {shown}");
                }
            }
        }
        "fetch" => {
            let id = a.pos.get(1).ok_or("fetch <id>")?;
            let cat = catalog()?;
            let asset = cat.get(id)?.ok_or_else(|| format!("no asset {id}"))?;
            let svg = a.flag("svg");
            let bytes = if svg {
                if a.opt("max-side").is_some() {
                    return Err("--max-side is for PNGs (an SVG scales freely)".into());
                }
                cat.fetch_svg(&asset)?
            } else {
                let png = cat.fetch_png(&asset)?;
                match a.opt("max-side") {
                    Some(m) => query::shrink_png(&png, m.parse().map_err(|_| "--max-side needs a number")?)?.0,
                    None => png,
                }
            };
            let name = format!("{}.{}", id.replace('/', "_"), if svg { "svg" } else { "png" });
            let out = match a.opt("out").map(PathBuf::from) {
                Some(p) if p.is_dir() => p.join(name),
                Some(p) => p,
                None => PathBuf::from(name),
            };
            std::fs::write(&out, &bytes).map_err(|e| format!("{}: {e}", out.display()))?;
            if json {
                print_json(&json!({"path": out, "bytes": bytes.len(), "credit": asset.credit, "license": asset.license}));
            } else {
                println!("{} ({} bytes) — {} [{}]", out.display(), bytes.len(), asset.credit, asset.license);
            }
            if a.flag("open") {
                open_file(&out)?;
            }
        }
        "upload" => upload(a)?,
        _ => print!("{}", usage()),
    }
    Ok(())
}

/// `upload`: submit image files, and the images in folders, to the review queue.
fn upload(a: &Args) -> Result<(), String> {
    let files = upload::collect_images(&a.pos[1..]).map_err(|e| if a.pos.len() < 2 { "upload <file|folder>... --license CC0-1.0|CC-BY-4.0".into() } else { e })?;
    if files.is_empty() {
        return Err("no images found (SVG, PNG, JPEG, WebP, GIF, BMP, TIFF or ICO)".into());
    }
    let license = a.opt("license").ok_or("--license is required: CC0-1.0 or CC-BY-4.0 (you confirm you may share the images under it)")?;
    let license = upload::LICENSES.iter().find(|l| l.eq_ignore_ascii_case(license)).ok_or("--license must be CC0-1.0 or CC-BY-4.0")?;
    if a.opt("title").is_some() && files.len() > 1 {
        return Err(format!("--title names one image, and there are {}; titles come from the file names", files.len()));
    }
    let category = match a.opt("category") {
        Some(c) => match taxonomy::resolve(c) {
            Some((cat, "")) => cat.to_string(),
            Some((_, sub)) => sub.to_string(),
            None => c.trim().to_string(),
        },
        None => String::new(),
    };
    let author = a.opt("credit").map(str::trim).filter(|c| !c.is_empty()).unwrap_or("anonymous");
    let clip = |s: &str, n: usize| s.trim().chars().take(n).collect::<String>();
    if files.len() > upload::MAX_PER_DAY {
        eprintln!("warning: {} images; the server takes {} a day from one address, so the rest will be refused", files.len(), upload::MAX_PER_DAY);
    }
    let (dry, json) = (a.flag("dry-run"), a.flag("json"));
    let url = upload::submit_url();
    let mut rows = Vec::new();
    let mut failed = 0;
    for path in &files {
        let title = a.opt("title").map_or_else(|| upload::title_from_path(path), |t| clip(t, 80));
        let meta = upload::Meta {
            title: title.clone(),
            description: clip(a.opt("description").unwrap_or_default(), 500),
            category: clip(&category, 60),
            author: clip(author, 60),
            license: license.to_string(),
        };
        let result = upload::prepare(path).and_then(|up| {
            if title.is_empty() {
                return Err("no title; pass --title".into());
            }
            if dry {
                return Ok((None, up.size));
            }
            match upload::submit_asset(&url, &meta, &up) {
                Ok(id) => Ok((Some(id), up.size)),
                Err(r) if r.status == 429 || r.status == 503 => Err(format!("stopped: {}", r.message)),
                Err(r) => Err(r.message),
            }
        });
        let stop = matches!(&result, Err(e) if e.starts_with("stopped: "));
        match result {
            Ok((id, size)) => {
                if !json {
                    let id = id.as_deref().map_or_else(|| "(dry run)".to_string(), |id| format!("{id} pending"));
                    let kind = size.map_or_else(|| "SVG".to_string(), |(w, h)| format!("{w}x{h}"));
                    println!("{:<40} {} ({kind}) — {}", id, path.display(), title);
                }
                let (w, h) = size.unzip();
                rows.push(json!({"path": path, "title": title, "id": id, "status": if dry { "dry-run" } else { "pending" }, "width": w, "height": h}));
            }
            Err(e) => {
                failed += 1;
                if !json {
                    eprintln!("{}: {e}", path.display());
                }
                rows.push(json!({"path": path, "title": title, "status": "error", "error": e}));
            }
        }
        if stop {
            break;
        }
    }
    if json {
        print_json(&rows);
    } else if !dry {
        let ok = rows.len() - failed;
        println!("\n{ok} submitted for review{}", if rows.len() < files.len() { format!("; {} not tried", files.len() - rows.len()) } else { String::new() });
    }
    if failed > 0 {
        return Err(format!("{failed} of {} could not be {}", files.len(), if dry { "read" } else { "submitted" }));
    }
    Ok(())
}

/// `--db-categories`: each collection's own categories (of the `--source` ones), for
/// `search --db-category`.
fn db_categories(a: &Args) -> Result<(), String> {
    let facets = Catalog::open_default()?.facets(&Filter::sources(&source_args(a)?))?;
    if a.flag("json") {
        let rows: Vec<Value> = facets.db_cats.iter().map(|(s, c, n)| json!({"source": s, "category": c, "icons": n})).collect();
        print_json(&rows);
    } else {
        for (s, c, n) in &facets.db_cats {
            println!("{:<58} {:>6}", format!("{s}:{c}"), n);
        }
    }
    Ok(())
}

/// `search`: icons and (when the program has them) templates.
fn search(a: &Args, q: &str, templates: Option<Templates>) -> Result<(), String> {
    let cols = icon_columns(a)?;
    let icon_filters = ICON_FILTERS.iter().any(|k| a.flag(k));
    let (only_icons, only_templates) = (a.flag("icons"), a.flag("templates"));
    if only_templates && icon_filters {
        return Err(format!("{} only apply to icons", ICON_FILTERS.map(|k| format!("--{k}")).join(", ")));
    }
    if only_templates && templates.is_none() {
        return Err("templates come with the BioCartoon editor's biocartoon command".into());
    }
    let want_icons = only_icons || !only_templates;
    let want_templates = templates.is_some() && (only_templates || (!only_icons && !icon_filters));
    let (limit, offset) = (a.num("limit", 12)?, a.num("offset", 0)?);
    let mut out = serde_json::Map::new();
    let mut icons = Vec::new();
    if want_icons {
        let cat = Catalog::open_default()?;
        let default_sort = if q.trim().is_empty() { IconSort::Alphabetical } else { IconSort::Relevance };
        if let Some(f) = icon_filter(a, &cat)? {
            icons = cat.search_filtered(q, &f, offset, limit, sort(a, default_sort))?.0;
        }
        out.insert("icons".into(), json!(icons));
    }
    let mut temps = Vec::new();
    if let (true, Some(t)) = (want_templates, templates) {
        temps = t(q).into_iter().skip(offset).take(limit).collect();
        out.insert("templates".into(), json!(temps));
    }
    if a.flag("json") {
        print_json(&out);
        return Ok(());
    }
    let both = want_icons && want_templates;
    if want_icons {
        if both {
            println!("ICONS");
        }
        print_assets(&icons, &cols);
    }
    if want_templates {
        if both {
            println!("\nTEMPLATES");
        }
        print_templates(&temps);
    }
    Ok(())
}

fn sort(a: &Args, default: IconSort) -> IconSort {
    match a.opt("sort") {
        None => default,
        Some("relevance") => IconSort::Relevance,
        Some(s) => mcp::parse_sort(s),
    }
}

/// `search --sql`: one read-only statement, or the schema when there is none.
fn run_sql(a: &Args, sql: &str) -> Result<(), String> {
    let cat = Catalog::open_default()?;
    if sql.trim().is_empty() {
        println!("{}", cat.schema()?);
        return Ok(());
    }
    let r = cat.sql(sql, a.num("max-rows", 200)?)?;
    if a.flag("json") {
        print_json(&r);
    } else {
        println!("{}", r.columns.join("\t"));
        for row in &r.rows {
            println!("{}", row.iter().map(|v| match v { Value::String(s) => s.clone(), Value::Null => String::new(), o => o.to_string() }).collect::<Vec<_>>().join("\t"));
        }
        if r.truncated {
            eprintln!("(truncated; raise --max-rows)");
        }
    }
    Ok(())
}

/// `--version`: `program_version`, and when the catalog in use was published (from its file name,
/// `assets-<UTC stamp>-<hash>.sqlite`) and downloaded (the file's time). Never downloads it.
pub fn version(a: &Args, program_version: &str) -> Result<(), String> {
    let from_env = std::env::var("BIOCARTOON_DB").is_ok_and(|v| !v.is_empty());
    let path = query::catalog_path().filter(|p| p.exists());
    let published = path.as_ref().and_then(|p| {
        let stamp = p.file_name()?.to_str()?.strip_prefix("assets-")?.split('-').next()?.to_string();
        // 20261019T230914Z -> 2026-10-19T23:09:14Z
        let d = stamp.as_bytes();
        (d.len() == 16 && d[8] == b'T').then(|| {
            format!("{}-{}-{}T{}:{}:{}Z", &stamp[0..4], &stamp[4..6], &stamp[6..8], &stamp[9..11], &stamp[11..13], &stamp[13..15])
        })
    });
    let downloaded = path.as_ref().and_then(|p| std::fs::metadata(p).ok()?.modified().ok()).map(utc);
    if a.flag("json") {
        print_json(&json!({"version": program_version, "catalog": path.as_ref().map(|p| json!({
            "path": p, "published": published, "downloaded": downloaded,
            "from_env": from_env,
        }))}));
        return Ok(());
    }
    println!("biocartoon {program_version}");
    let human = |t: &str| t.replace('T', " ").trim_end_matches('Z').get(..16).map(|t| format!("{t} UTC")).unwrap_or_default();
    match &path {
        None if from_env => println!("catalog    {} does not exist (from --db / BIOCARTOON_DB)", std::env::var("BIOCARTOON_DB").unwrap_or_default()),
        None => println!("catalog    not downloaded yet (the first search downloads it, or run biocartoon sync)"),
        Some(p) => {
            let mut when = Vec::new();
            if let Some(t) = &published {
                when.push(format!("published {}", human(t)));
            }
            if let Some(t) = &downloaded {
                // A --db file is the caller's own, not one this program downloaded.
                when.push(format!("{} {}", if from_env { "modified" } else { "downloaded" }, human(t)));
            }
            println!("catalog    {}", when.join(", "));
            println!("           {}", p.display());
        }
    }
    Ok(())
}

/// A time as `YYYY-MM-DDTHH:MM:SSZ`.
fn utc(t: std::time::SystemTime) -> String {
    let secs = t.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem / 60 % 60, rem % 60)
}

/// `biocartoon <argv...>`.
pub fn run(argv: Vec<String>) -> Result<(), String> {
    let a = Args::parse(argv, &[]);
    a.apply_env();
    if a.wants_help() {
        print!("{}", usage());
        return Ok(());
    }
    if a.flag("version") {
        return version(&a, env!("CARGO_PKG_VERSION"));
    }
    if a.command() == "mcp" {
        return mcp::serve_catalog();
    }
    run_command(&a, None).unwrap_or_else(|| Err(format!("unknown command {:?}\n\n{}", a.command(), usage())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_sql() {
        assert!(looks_like_sql("SELECT id FROM assets"));
        assert!(looks_like_sql("with x as (select 1) select * from x"));
        assert!(looks_like_sql("pragma table_info(assets)"));
        assert!(!looks_like_sql("select"));
        assert!(!looks_like_sql("select tool for cells"));
        assert!(!looks_like_sql("neuron with dendrites"));
    }

    #[test]
    fn formats_utc() {
        let at = |s: u64| utc(std::time::UNIX_EPOCH + std::time::Duration::from_secs(s));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_792_451_354), "2026-10-19T23:09:14Z");
    }
}
