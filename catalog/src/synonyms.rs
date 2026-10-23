//! Words a search also looks for: a query word in one of [`GROUPS`] also finds the group's other
//! words ("mouse" finds rats and hamsters too, "rbc" finds erythrocytes). The search ranks icons
//! matching the typed word first (see `Worker::fts_term`).
//!
//! Each group is symmetric, so keep it to words a person looking for one would be glad to see the
//! others for. Leave out broad words ("cell", "blood", "red", "tube"): they would pull in half the
//! catalog. Entries are lowercase; one with a space is matched as a phrase, and the index stems
//! each one, so plurals of an entry are found without listing them.

/// Groups of related words.
pub const GROUPS: &[&[&str]] = &[
    // Organisms
    &["mouse", "mice", "rat", "rodent", "hamster", "guinea pig", "gerbil"],
    &["drosophila", "fruit fly"],
    &["nematode", "elegans", "roundworm"],
    &["zebrafish", "danio"],
    &["frog", "xenopus", "toad", "tadpole"],
    &["yeast", "saccharomyces"],
    &["arabidopsis", "thale cress"],
    &["monkey", "macaque", "primate", "ape", "chimpanzee", "gorilla", "baboon"],
    &["pig", "swine", "piglet", "hog", "porcine"],
    &["cow", "cattle", "bovine", "calf", "bull"],
    &["dog", "canine", "puppy"],
    &["cat", "feline", "kitten"],
    &["chicken", "hen", "rooster", "poultry"],
    &["sheep", "lamb", "ovine"],
    &["horse", "equine", "pony"],
    &["bird", "avian"],
    // Microbes
    &["bacteria", "bacterium", "bacterial", "microbe", "germ", "prokaryote"],
    &["virus", "viral", "virion"],
    &["phage", "bacteriophage"],
    &["fungus", "fungi", "fungal", "mold", "mould"],
    // Blood and immunity
    &["antibody", "immunoglobulin", "igg", "igm", "iga", "ige"],
    &["erythrocyte", "rbc", "red blood cell"],
    &["leukocyte", "wbc", "white blood cell"],
    &["platelet", "thrombocyte"],
    &["vaccine", "vaccination", "immunization", "immunisation"],
    // Anatomy
    &["neuron", "neurone", "nerve cell"],
    &["brain", "cerebral", "cerebrum"],
    &["heart", "cardiac"],
    &["kidney", "renal"],
    &["liver", "hepatic"],
    &["lung", "pulmonary"],
    &["stomach", "gastric"],
    &["intestine", "intestinal", "gut", "bowel"],
    &["skin", "dermal", "epidermis", "cutaneous"],
    &["bone", "skeleton", "skeletal"],
    &["tooth", "teeth", "dental"],
    &["eye", "ocular", "eyeball"],
    &["artery", "arterial"],
    &["vein", "venous"],
    &["sperm", "spermatozoon", "spermatozoa"],
    &["oocyte", "ovum", "egg cell"],
    &["embryo", "fetus", "foetus"],
    // Medicine
    &["tumor", "tumour", "cancer", "carcinoma", "neoplasm", "malignancy"],
    &["pill", "tablet", "capsule"],
    &["syringe", "needle", "injection"],
    &["doctor", "physician", "clinician", "medic"],
    &["hospital", "clinic"],
    // Molecules and cell parts
    &["mitochondria", "mitochondrion", "mitochondrial"],
    &["mrna", "messenger rna"],
    &["dna", "deoxyribonucleic", "double helix"],
    // Lab
    &["pipette", "micropipette", "pipettor"],
    &["eppendorf", "microcentrifuge tube", "microtube"],
    &["petri", "culture dish", "agar plate"],
    &["flask", "erlenmeyer"],
    &["microscope", "microscopy"],
    &["centrifuge", "centrifugation"],
    // People and things
    &["scientist", "researcher"],
    &["baby", "infant", "newborn"],
    &["child", "children", "kid"],
    &["computer", "laptop", "pc"],
    &["graph", "chart", "plot"],
];

/// The other words of every group holding `word` (a lowercase query word; a plural "s" or "es"
/// is dropped when only the singular is listed), each once.
pub fn related(word: &str) -> Vec<&'static str> {
    let forms = [Some(word), word.strip_suffix('s'), word.strip_suffix("es")];
    let mut out: Vec<&'static str> = Vec::new();
    for group in GROUPS {
        let Some(own) = group.iter().find(|g| forms.contains(&Some(**g))) else { continue };
        for w in group.iter().filter(|w| *w != own) {
            if !out.contains(w) {
                out.push(w);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_are_lowercase_and_listed_once() {
        let mut seen = std::collections::HashSet::new();
        for w in GROUPS.iter().flat_map(|g| g.iter()) {
            assert_eq!(*w, w.to_lowercase(), "{w}");
            assert!(seen.insert(*w), "{w} is in two groups");
        }
    }

    #[test]
    fn plurals_find_their_group() {
        assert!(related("mouse").contains(&"rat"));
        assert!(related("rats").contains(&"mouse"));
        assert!(!related("rats").contains(&"rat"));
        assert!(related("viruses").contains(&"viral"));
        assert!(related("flask").contains(&"erlenmeyer"));
        assert!(related("cell").is_empty());
    }
}
