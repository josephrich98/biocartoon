//! `biocartoon install-skills`: copy the agent skills that ship inside this program (from
//! `catalog/skills/`) into an assistant's skills folder.

use std::path::{Path, PathBuf};

/// The shipped skills: (name, SKILL.md).
pub const SKILLS: &[(&str, &str)] = &[
    ("biocartoon-find-icons", include_str!("../skills/biocartoon-find-icons/SKILL.md")),
    ("biocartoon-create-icon", include_str!("../skills/biocartoon-create-icon/SKILL.md")),
    ("biocartoon-upload", include_str!("../skills/biocartoon-upload/SKILL.md")),
    ("biocartoon-make-figure", include_str!("../skills/biocartoon-make-figure/SKILL.md")),
];

/// A file left in each installed skill, so a later install or uninstall knows it put it there.
const MARKER: &str = ".installed-by-biocartoon";

/// The skills folder of `agent` (`claude` or `codex`), or `dest` when given.
pub fn target_dir(agent: &str, dest: Option<&str>) -> Result<PathBuf, String> {
    if let Some(d) = dest {
        return Ok(PathBuf::from(d));
    }
    let home = dirs::home_dir().ok_or("no home folder; pass --dest DIR")?;
    match agent {
        "claude" | "claude-code" => Ok(home.join(".claude").join("skills")),
        "codex" => Ok(home.join(".codex").join("skills")),
        other => Err(format!("unknown agent {other:?}: claude or codex (or --dest DIR for any other)")),
    }
}

/// Install every skill into `dir`. A skill folder this program didn't make is left alone unless
/// `overwrite`. Returns what happened to each.
pub fn install(dir: &Path, overwrite: bool) -> Result<Vec<(String, &'static str)>, String> {
    let mut out = Vec::new();
    for (name, body) in SKILLS {
        let d = dir.join(name);
        let ours = d.join(MARKER).exists();
        if d.exists() && !ours && !overwrite {
            out.push((name.to_string(), "skipped"));
            continue;
        }
        std::fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
        std::fs::write(d.join("SKILL.md"), body).map_err(|e| format!("{}: {e}", d.display()))?;
        std::fs::write(d.join(MARKER), env!("CARGO_PKG_VERSION")).map_err(|e| format!("{}: {e}", d.display()))?;
        out.push((name.to_string(), if ours { "updated" } else { "installed" }));
    }
    Ok(out)
}

/// Remove the skills this program installed in `dir`.
pub fn uninstall(dir: &Path) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    for (name, _) in SKILLS {
        let d = dir.join(name);
        if d.join(MARKER).exists() {
            std::fs::remove_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
            removed.push(name.to_string());
        }
    }
    Ok(removed)
}

/// Each skill's `description` from its front matter.
pub fn description(body: &str) -> &str {
    body.lines().find_map(|l| l.strip_prefix("description: ")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_have_front_matter() {
        for (name, body) in SKILLS {
            assert!(body.starts_with("---\n"), "{name}");
            assert!(body.contains(&format!("\nname: {name}\n")), "{name}");
            assert!(!description(body).is_empty(), "{name}");
        }
    }

    #[test]
    fn installs_updates_and_keeps_foreign_folders() {
        let dir = std::env::temp_dir().join(format!("biocartoon-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("biocartoon-create-icon")).unwrap();
        let r = install(&dir, false).unwrap();
        assert_eq!(r[..2], [("biocartoon-find-icons".to_string(), "installed"), ("biocartoon-create-icon".to_string(), "skipped")]);
        assert_eq!(install(&dir, false).unwrap()[0].1, "updated");
        assert_eq!(install(&dir, true).unwrap()[1].1, "installed");
        assert_eq!(uninstall(&dir).unwrap().len(), SKILLS.len());
        assert!(!dir.join("biocartoon-find-icons").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
