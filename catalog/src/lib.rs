//! biocartoon-catalog: the BioCartoon asset catalog (about 20,000 open-licensed scientific
//! illustrations from NIH BioArt, Bioicons, Servier Medical Art, SciDraw, Health Icons, Reactome
//! and OpenMoji, plus user uploads) as a library, a command line (`biocartoon`) and an MCP
//! server (`biocartoon mcp`).
//!
//! The catalog is a SQLite file published to `<asset URL>/catalog/` by `data/publish_catalog.py`;
//! every row's PNG is at `<asset URL>/<png_key>`. [`query::Catalog`] is the simplest way in:
//!
//! ```no_run
//! let cat = biocartoon_catalog::query::Catalog::open_default()?; // downloads it the first time
//! for a in cat.search("neuron", &[], 5, biocartoon_catalog::catalog::IconSort::Relevance)? {
//!     println!("{} {} ({}; {})", a.id, a.title, a.license, a.credit);
//! }
//! # Ok::<(), String>(())
//! ```
//!
//! Each asset keeps its own upstream license; show its `credit` and follow its `license`.

pub mod catalog;
pub mod synonyms;
pub mod taxonomy;
#[cfg(not(target_arch = "wasm32"))]
pub mod cli;
#[cfg(not(target_arch = "wasm32"))]
pub mod mcp;
#[cfg(not(target_arch = "wasm32"))]
pub mod query;
#[cfg(not(target_arch = "wasm32"))]
pub mod templates;
#[cfg(not(target_arch = "wasm32"))]
pub mod upload;

/// Where the published catalog and every asset PNG are served from (`BIOCARTOON_ASSET_URL`
/// overrides it in the command line and the editor).
pub const DEFAULT_ASSET_URL: &str = "https://assets.biocartoon.com";
