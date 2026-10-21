//! BioCartoon's own categories, shared by every database and by user uploads ("Browse
//! categories"). Each asset's database categories are mapped onto [`TAXONOMY`]; assets with no
//! usable category (user uploads, Servier's uncategorized files) are placed by the
//! words of their title and tags instead, and whatever is left goes to [`OTHER`].

use std::collections::HashMap;
use std::sync::OnceLock;

/// A (category, subcategory) pair of [`TAXONOMY`].
pub type Taxon = (&'static str, &'static str);

const ANATOMY: &str = "Anatomy and physiology";
const CELLS: &str = "Cells";
const DATA: &str = "Data and computing";
const EVERYDAY: &str = "Everyday";
const LAB: &str = "Lab and techniques";
const MEDICINE: &str = "Medicine and health";
const MICROBES: &str = "Microbes and pathogens";
const MOLECULES: &str = "Molecules";
const ORGANISMS: &str = "Organisms";
const PEOPLE: &str = "People";
const SYMBOLS: &str = "Symbols and shapes";

const BLOOD: Taxon = (ANATOMY, "Blood and immunity");
const BODY: Taxon = (ANATOMY, "Body and organs");
const CARDIO: Taxon = (ANATOMY, "Cardiovascular system");
const DIGESTIVE: Taxon = (ANATOMY, "Digestive system");
const MUSCULO: Taxon = (ANATOMY, "Musculoskeletal system");
const NERVOUS: Taxon = (ANATOMY, "Nervous system");
const REPRO: Taxon = (ANATOMY, "Reproduction and development");
const RESPIRATORY: Taxon = (ANATOMY, "Respiratory system");
const SENSES: Taxon = (ANATOMY, "Sensory organs");
const TISSUES: Taxon = (ANATOMY, "Tissues");
const CELL_SCENES: Taxon = (CELLS, "Cell scenes and processes");
const CELL_TYPES: Taxon = (CELLS, "Cell types");
const MEMBRANES: Taxon = (CELLS, "Membranes, receptors and channels");
const ORGANELLES: Taxon = (CELLS, "Organelles and cell components");
const BIOINFO: Taxon = (DATA, "Bioinformatics and machine learning");
const CHARTS: Taxon = (DATA, "Charts and graphs");
const COMPUTERS: Taxon = (DATA, "Computers and devices");
const ACTIVITIES: Taxon = (EVERYDAY, "Activities and sport");
const CLOTHING: Taxon = (EVERYDAY, "Clothing");
const FACES: Taxon = (EVERYDAY, "Faces and emotions");
const FLAGS: Taxon = (EVERYDAY, "Flags");
const FOOD: Taxon = (EVERYDAY, "Food and drink");
const OBJECTS: Taxon = (EVERYDAY, "Objects");
const PLACES: Taxon = (EVERYDAY, "Places and travel");
const NATURE: Taxon = (EVERYDAY, "Weather and nature");
const IMAGING: Taxon = (LAB, "Imaging");
const LAB_EQUIPMENT: Taxon = (LAB, "Lab equipment");
const SAFETY: Taxon = (LAB, "Safety");
const TECHNIQUES: Taxon = (LAB, "Techniques and procedures");
const CONDITIONS: Taxon = (MEDICINE, "Conditions and specialties");
const DRUGS: Taxon = (MEDICINE, "Drugs and therapeutics");
const MED_EQUIPMENT: Taxon = (MEDICINE, "Medical equipment and PPE");
const PUBLIC_HEALTH: Taxon = (MEDICINE, "Public health");
const BACTERIA: Taxon = (MICROBES, "Bacteria");
const FUNGI: Taxon = (MICROBES, "Fungi");
const PARASITES: Taxon = (MICROBES, "Parasites");
const VIRUSES: Taxon = (MICROBES, "Viruses");
const AMINO: Taxon = (MOLECULES, "Amino acids and peptides");
const CHEMISTRY: Taxon = (MOLECULES, "Chemistry and small molecules");
const LIPIDS: Taxon = (MOLECULES, "Lipids");
const NUCLEIC: Taxon = (MOLECULES, "Nucleic acids and genetics");
const PROTEINS: Taxon = (MOLECULES, "Proteins");
const ANIMALS: Taxon = (ORGANISMS, "Animals");
const INSECTS: Taxon = (ORGANISMS, "Insects and arthropods");
const MODEL_ORGANISMS: Taxon = (ORGANISMS, "Model organisms");
const PLANTS: Taxon = (ORGANISMS, "Plants and algae");
const BODY_PARTS: Taxon = (PEOPLE, "Body parts and gestures");
const PERSONS: Taxon = (PEOPLE, "People and roles");
const ARROWS: Taxon = (SYMBOLS, "Arrows and lines");
const SHAPES: Taxon = (SYMBOLS, "Shapes");
const SIGNS: Taxon = (SYMBOLS, "Signs and symbols");
const TEXT: Taxon = (SYMBOLS, "Text and numbers");
/// Where assets nothing else fits go; always listed last.
pub const OTHER: Taxon = ("Other", "Uncategorized");

/// Every category with its subcategories, alphabetical, [`OTHER`] last.
pub const TAXONOMY: &[(&str, &[&str])] = &[
    (ANATOMY, &[BLOOD.1, BODY.1, CARDIO.1, DIGESTIVE.1, MUSCULO.1, NERVOUS.1, REPRO.1, RESPIRATORY.1, SENSES.1, TISSUES.1]),
    (CELLS, &[CELL_SCENES.1, CELL_TYPES.1, MEMBRANES.1, ORGANELLES.1]),
    (DATA, &[BIOINFO.1, CHARTS.1, COMPUTERS.1]),
    (EVERYDAY, &[ACTIVITIES.1, CLOTHING.1, FACES.1, FLAGS.1, FOOD.1, OBJECTS.1, PLACES.1, NATURE.1]),
    (LAB, &[IMAGING.1, LAB_EQUIPMENT.1, SAFETY.1, TECHNIQUES.1]),
    (MEDICINE, &[CONDITIONS.1, DRUGS.1, MED_EQUIPMENT.1, PUBLIC_HEALTH.1]),
    (MICROBES, &[BACTERIA.1, FUNGI.1, PARASITES.1, VIRUSES.1]),
    (MOLECULES, &[AMINO.1, CHEMISTRY.1, LIPIDS.1, NUCLEIC.1, PROTEINS.1]),
    (ORGANISMS, &[ANIMALS.1, INSECTS.1, MODEL_ORGANISMS.1, PLANTS.1]),
    (PEOPLE, &[BODY_PARTS.1, PERSONS.1]),
    (SYMBOLS, &[ARROWS.1, SHAPES.1, SIGNS.1, TEXT.1]),
    (OTHER.0, &[OTHER.1]),
];

/// `(substring of the lowercased database category, taxon)`, first match wins; `None` means
/// "too vague, place it by its title instead".
type Rules = &'static [(&'static str, Option<Taxon>)];

const BIOART: Rules = &[
    ("anatomy", Some(BODY)),
    ("arthropods", Some(INSECTS)),
    ("other organisms", Some(ANIMALS)),
    ("animals", Some(ANIMALS)),
    ("bacteria", Some(BACTERIA)),
    ("cell scenes", Some(CELL_SCENES)),
    ("cellular processes", Some(CELL_SCENES)),
    // Split further by title in `classify`.
    ("cells and organelles", Some(CELL_TYPES)),
    ("data visualization", Some(CHARTS)),
    ("environments", Some(PLACES)),
    ("equipment", Some(LAB_EQUIPMENT)),
    ("fungi", Some(FUNGI)),
    ("molecules", Some(CHEMISTRY)),
    ("parasites", Some(PARASITES)),
    ("people", Some(PERSONS)),
    ("plants", Some(PLANTS)),
    ("proteins", Some(PROTEINS)),
    ("shapes", Some(SHAPES)),
    ("techniques", Some(TECHNIQUES)),
    ("viruses", Some(VIRUSES)),
];

const BIOICONS: Rules = &[
    ("amino", Some(AMINO)),
    ("peptides", Some(AMINO)),
    ("animals", Some(ANIMALS)),
    ("blood", Some(BLOOD)),
    ("cell culture", Some(LAB_EQUIPMENT)),
    ("cell lines", Some(CELL_TYPES)),
    ("cell types", Some(CELL_TYPES)),
    ("cell membrane", Some(MEMBRANES)),
    ("receptors", Some(MEMBRANES)),
    ("bioinformatics", Some(BIOINFO)),
    ("machine learning", Some(BIOINFO)),
    ("computer", Some(COMPUTERS)),
    ("chemistry", Some(CHEMISTRY)),
    ("nanotechnology", Some(CHEMISTRY)),
    ("epigenetics", Some(NUCLEIC)),
    ("genetics", Some(NUCLEIC)),
    ("genomics", Some(NUCLEIC)),
    ("molecular biology", Some(NUCLEIC)),
    ("nucleic", Some(NUCLEIC)),
    ("molecular modelling", Some(PROTEINS)),
    ("extracellular matrix", Some(TISSUES)),
    ("tissues", Some(TISSUES)),
    ("general items", Some(OBJECTS)),
    ("human physiology", Some(BODY)),
    ("imaging", Some(IMAGING)),
    ("intracellular", Some(ORGANELLES)),
    ("lab apparatus", Some(LAB_EQUIPMENT)),
    ("microbiology", Some(BACTERIA)),
    ("neuroscience", Some(NERVOUS)),
    ("oncology", Some(CONDITIONS)),
    ("parasites", Some(PARASITES)),
    ("people", Some(PERSONS)),
    ("plants", Some(PLANTS)),
    ("procedures", Some(TECHNIQUES)),
    ("safety", Some(SAFETY)),
    ("graphs", Some(CHARTS)),
    ("viruses", Some(VIRUSES)),
];

const HEALTHICONS: Rules = &[
    ("blood", Some(BLOOD)),
    ("body", Some(BODY)),
    ("conditions", Some(CONDITIONS)),
    ("specialties", Some(CONDITIONS)),
    ("contraceptives", Some(DRUGS)),
    ("medications", Some(DRUGS)),
    ("devices", Some(MED_EQUIPMENT)),
    ("diagnostics", Some(MED_EQUIPMENT)),
    ("ppe", Some(MED_EQUIPMENT)),
    ("emotions", Some(FACES)),
    ("exercise", Some(ACTIVITIES)),
    ("graphs", Some(CHARTS)),
    ("nutrition", Some(FOOD)),
    ("objects", Some(OBJECTS)),
    ("people", Some(PERSONS)),
    ("places", Some(PLACES)),
    ("vehicles", Some(PLACES)),
    ("shapes", Some(SHAPES)),
    ("symbols", Some(SIGNS)),
    ("typography", Some(TEXT)),
    ("zoonoses", Some(PUBLIC_HEALTH)),
];

/// OpenMoji categories are "group / subgroup".
const OPENMOJI: Rules = &[
    ("smileys-emotion", Some(FACES)),
    ("body-parts", Some(BODY_PARTS)),
    ("hand", Some(BODY_PARTS)),
    ("people", Some(PERSONS)),
    ("component", Some(PERSONS)),
    ("animal-bug", Some(INSECTS)),
    ("plant", Some(PLANTS)),
    ("gardening", Some(PLANTS)),
    ("animal", Some(ANIMALS)),
    ("food-drink", Some(FOOD)),
    ("flag", Some(FLAGS)),
    ("regional-indicator", Some(FLAGS)),
    ("activities", Some(ACTIVITIES)),
    ("clothing", Some(CLOTHING)),
    ("objects / medical", Some(MED_EQUIPMENT)),
    ("healthcare", Some(PUBLIC_HEALTH)),
    ("emergency", Some(PUBLIC_HEALTH)),
    ("objects / science", Some(LAB_EQUIPMENT)),
    ("computer", Some(COMPUTERS)),
    ("technology", Some(COMPUTERS)),
    ("phone", Some(COMPUTERS)),
    ("objects", Some(OBJECTS)),
    ("sky-weather", Some(NATURE)),
    ("climate-environment", Some(NATURE)),
    ("travel-places", Some(PLACES)),
    ("arrow", Some(ARROWS)),
    ("geometric", Some(SHAPES)),
    ("alphanum", Some(TEXT)),
    ("keycap", Some(TEXT)),
    ("math", Some(TEXT)),
    ("punctuation", Some(TEXT)),
    ("symbol", Some(SIGNS)),
    ("ui-element", Some(SIGNS)),
    ("interaction", Some(SIGNS)),
    ("brand", Some(SIGNS)),
];

const REACTOME: Rules = &[
    ("arrow", Some(ARROWS)),
    ("background", Some(ORGANELLES)),
    ("cell element", Some(ORGANELLES)),
    ("cell type", Some(CELL_TYPES)),
    ("compound", Some(CHEMISTRY)),
    ("tissue", Some(TISSUES)),
    ("receptor", Some(MEMBRANES)),
    ("transporter", Some(MEMBRANES)),
    ("protein", Some(PROTEINS)),
    ("therapeutic", Some(DRUGS)),
];

const SCIDRAW: Rules = &[
    ("bird", Some(MODEL_ORGANISMS)),
    ("drosophila", Some(MODEL_ORGANISMS)),
    ("fish", Some(MODEL_ORGANISMS)),
    ("mouse", Some(MODEL_ORGANISMS)),
    ("rat", Some(MODEL_ORGANISMS)),
    ("human", Some(BODY)),
    ("cell", Some(CELL_TYPES)),
    ("other", None),
];

/// Servier categories are "section / subsection / ...": most specific first.
const SERVIER: Rules = &[
    ("auditory", Some(SENSES)),
    ("visual system", Some(SENSES)),
    ("cardiovascular system / blood", Some(BLOOD)),
    ("cardiovascular", Some(CARDIO)),
    ("cardiology", Some(CARDIO)),
    ("digestive", Some(DIGESTIVE)),
    ("locomotor", Some(MUSCULO)),
    ("lymphatic", Some(BLOOD)),
    ("immunology", Some(BLOOD)),
    ("nervous system", Some(NERVOUS)),
    ("reproductive", Some(REPRO)),
    ("embryology", Some(REPRO)),
    ("respiratory", Some(RESPIRATORY)),
    ("pulmonology", Some(RESPIRATORY)),
    ("anatomy and the human body", Some(BODY)),
    ("cell membrane", Some(MEMBRANES)),
    ("receptors and channels", Some(MEMBRANES)),
    ("genetics", Some(NUCLEIC)),
    ("nucleic acids", Some(NUCLEIC)),
    ("intracellular", Some(ORGANELLES)),
    ("lipids", Some(LIPIDS)),
    ("tissues", Some(TISSUES)),
    ("rodents", Some(MODEL_ORGANISMS)),
    ("animals", Some(ANIMALS)),
    ("clothes", Some(CLOTHING)),
    ("drugs", Some(DRUGS)),
    ("laboratory equipment", Some(LAB_EQUIPMENT)),
    ("mobile device", Some(COMPUTERS)),
    ("equipment", Some(MED_EQUIPMENT)),
    ("food", Some(FOOD)),
    ("arrows", Some(ARROWS)),
    ("bubbles", Some(SHAPES)),
    ("places", Some(PLACES)),
    ("world maps", Some(PLACES)),
    ("time", Some(SIGNS)),
    ("people", Some(PERSONS)),
    ("micology", Some(FUNGI)),
    ("parasitology", Some(PARASITES)),
    ("virology", Some(VIRUSES)),
    ("infectiology", Some(BACTERIA)),
    ("medical specialties", Some(CONDITIONS)),
    ("scientific illustrations", None),
    ("other general items / other", None),
    ("other general items", Some(OBJECTS)),
];

/// Title and tag words, for assets the database categories don't place. A trailing `*` matches
/// any word starting with it; otherwise the word itself or its plural.
const KEYWORDS: &[(&str, Taxon)] = &[
    ("vir*", VIRUSES), ("phage*", VIRUSES), ("covid", VIRUSES), ("coronavirus", VIRUSES), ("influenza", VIRUSES), ("hiv", VIRUSES),
    ("bacteri*", BACTERIA), ("bacillus", BACTERIA), ("staphylococc*", BACTERIA), ("streptococc*", BACTERIA), ("microb*", BACTERIA),
    ("parasit*", PARASITES), ("plasmodium", PARASITES), ("malaria", PARASITES), ("worm", PARASITES), ("helminth*", PARASITES),
    ("fung*", FUNGI), ("yeast", FUNGI), ("candida", FUNGI), ("mushroom", FUNGI), ("mold", FUNGI),
    ("heart", CARDIO), ("arter*", CARDIO), ("vein", CARDIO), ("vessel", CARDIO), ("capillar*", CARDIO), ("atherom*", CARDIO),
    ("atheroscl*", CARDIO), ("atherothromb*", CARDIO), ("aorta", CARDIO), ("coronary", CARDIO), ("cabg", CARDIO),
    ("blood", BLOOD), ("platelet", BLOOD), ("erythrocyte", BLOOD), ("antibod*", BLOOD), ("immun*", BLOOD), ("lymph*", BLOOD),
    ("macrophage", BLOOD), ("neutrophil", BLOOD), ("leukocyte", BLOOD),
    ("brain", NERVOUS), ("neur*", NERVOUS), ("nerve", NERVOUS), ("spinal", NERVOUS), ("synap*", NERVOUS), ("cortex", NERVOUS), ("glia*", NERVOUS),
    ("lung", RESPIRATORY), ("bronch*", RESPIRATORY), ("trachea", RESPIRATORY), ("alveol*", RESPIRATORY),
    ("stomach", DIGESTIVE), ("intestin*", DIGESTIVE), ("colon", DIGESTIVE), ("liver", DIGESTIVE), ("pancrea*", DIGESTIVE),
    ("oesophag*", DIGESTIVE), ("esophag*", DIGESTIVE), ("gut", DIGESTIVE),
    ("bone", MUSCULO), ("skeleton", MUSCULO), ("skull", MUSCULO), ("muscle", MUSCULO), ("joint", MUSCULO), ("knee", MUSCULO), ("spine", MUSCULO),
    ("eye", SENSES), ("retina", SENSES), ("ear", SENSES), ("cochlea", SENSES), ("skin", SENSES),
    ("kidney", BODY), ("bladder", BODY), ("organ", BODY), ("gland", BODY), ("thyroid", BODY), ("anatom*", BODY), ("torso", BODY),
    ("uterus", REPRO), ("ovar*", REPRO), ("testis", REPRO), ("sperm*", REPRO), ("embryo*", REPRO), ("fetus", REPRO), ("placenta", REPRO), ("pregnan*", REPRO),
    ("tissue", TISSUES), ("epitheli*", TISSUES),
    ("mitochondri*", ORGANELLES), ("nucleus", ORGANELLES), ("ribosome", ORGANELLES), ("golgi", ORGANELLES), ("reticulum", ORGANELLES),
    ("vesicle", ORGANELLES), ("lysosome", ORGANELLES), ("organelle", ORGANELLES), ("chromosome", ORGANELLES), ("cytoskelet*", ORGANELLES),
    ("membrane", MEMBRANES), ("receptor", MEMBRANES), ("channel", MEMBRANES), ("pump", MEMBRANES), ("transporter", MEMBRANES),
    ("cell", CELL_TYPES), ("cyte", CELL_TYPES),
    ("dna", NUCLEIC), ("rna", NUCLEIC), ("mrna", NUCLEIC), ("gene", NUCLEIC), ("genom*", NUCLEIC), ("plasmid", NUCLEIC), ("nucleotide", NUCLEIC), ("helix", NUCLEIC),
    ("protein", PROTEINS), ("enzyme", PROTEINS), ("kinase", PROTEINS),
    ("amino", AMINO), ("peptide", AMINO),
    ("lipid", LIPIDS), ("cholesterol", LIPIDS), ("phospholipid", LIPIDS),
    ("molecule", CHEMISTRY), ("molecular", CHEMISTRY), ("chemical", CHEMISTRY), ("chemistry", CHEMISTRY), ("atom", CHEMISTRY),
    ("compound", CHEMISTRY), ("benzene", CHEMISTRY), ("glucose", CHEMISTRY),
    ("pill", DRUGS), ("drug", DRUGS), ("tablet", DRUGS), ("capsule", DRUGS), ("vaccine", DRUGS), ("medicine", DRUGS), ("medication", DRUGS),
    ("flask", LAB_EQUIPMENT), ("beaker", LAB_EQUIPMENT), ("pipette", LAB_EQUIPMENT), ("microscope", LAB_EQUIPMENT), ("centrifuge", LAB_EQUIPMENT),
    ("petri", LAB_EQUIPMENT), ("funnel", LAB_EQUIPMENT), ("burner", LAB_EQUIPMENT), ("burette", LAB_EQUIPMENT), ("laboratory", LAB_EQUIPMENT),
    ("tube", LAB_EQUIPMENT), ("eppendorf", LAB_EQUIPMENT),
    ("microscopy", IMAGING), ("mri", IMAGING), ("xray", IMAGING), ("ultrasound", IMAGING), ("radiograph*", IMAGING),
    ("biohazard", SAFETY), ("hazard", SAFETY), ("radioactive", SAFETY), ("toxic", SAFETY),
    ("hospital", MED_EQUIPMENT), ("stethoscope", MED_EQUIPMENT), ("wheelchair", MED_EQUIPMENT), ("bandage", MED_EQUIPMENT),
    ("syringe", MED_EQUIPMENT), ("thermometer", MED_EQUIPMENT), ("ambulance", MED_EQUIPMENT), ("scalpel", MED_EQUIPMENT),
    ("cancer", CONDITIONS), ("tumor", CONDITIONS), ("tumour", CONDITIONS), ("disease", CONDITIONS), ("infection", CONDITIONS),
    ("burns", CONDITIONS), ("wound", CONDITIONS), ("diabet*", CONDITIONS), ("fracture", CONDITIONS), ("surgery", CONDITIONS), ("stroke", CONDITIONS),
    ("mouse", MODEL_ORGANISMS), ("mice", MODEL_ORGANISMS), ("rat", MODEL_ORGANISMS), ("zebrafish", MODEL_ORGANISMS),
    ("drosophila", MODEL_ORGANISMS), ("elegans", MODEL_ORGANISMS), ("rodent", MODEL_ORGANISMS),
    ("insect", INSECTS), ("bee", INSECTS), ("ant", INSECTS), ("butterfl*", INSECTS), ("mosquito", INSECTS), ("fly", INSECTS),
    ("flies", INSECTS), ("spider", INSECTS), ("beetle", INSECTS), ("bug", INSECTS), ("tick", INSECTS),
    ("tree", PLANTS), ("flower", PLANTS), ("plant", PLANTS), ("leaf", PLANTS), ("leaves", PLANTS), ("alga*", PLANTS), ("grass", PLANTS), ("rose", PLANTS),
    ("animal", ANIMALS), ("dog", ANIMALS), ("cat", ANIMALS), ("bird", ANIMALS), ("fish", ANIMALS), ("horse", ANIMALS), ("cow", ANIMALS),
    ("pig", ANIMALS), ("monkey", ANIMALS), ("ape", ANIMALS), ("lion", ANIMALS), ("bear", ANIMALS), ("frog", ANIMALS), ("snake", ANIMALS),
    ("sheep", ANIMALS), ("rabbit", ANIMALS), ("chicken", ANIMALS), ("duck", ANIMALS), ("owl", ANIMALS), ("elephant", ANIMALS),
    ("hand", BODY_PARTS), ("finger", BODY_PARTS), ("foot", BODY_PARTS), ("feet", BODY_PARTS),
    ("face", FACES), ("smile*", FACES), ("smiley", FACES), ("emotion*", FACES), ("emoticon", FACES), ("happy", FACES), ("sad", FACES), ("angry", FACES),
    ("person", PERSONS), ("people", PERSONS), ("man", PERSONS), ("men", PERSONS), ("woman", PERSONS), ("women", PERSONS), ("child", PERSONS),
    ("children", PERSONS), ("kid", PERSONS), ("boy", PERSONS), ("girl", PERSONS), ("doctor", PERSONS), ("nurse", PERSONS),
    ("scientist", PERSONS), ("human", PERSONS), ("patient", PERSONS), ("family", PERSONS), ("baby", PERSONS),
    ("flag", FLAGS),
    ("food", FOOD), ("fruit", FOOD), ("apple", FOOD), ("vegetable", FOOD), ("bread", FOOD), ("cheese", FOOD), ("butter", FOOD),
    ("cabbage", FOOD), ("camembert", FOOD), ("drink", FOOD), ("coffee", FOOD), ("tea", FOOD), ("wine", FOOD), ("beer", FOOD), ("meat", FOOD),
    ("cake", FOOD), ("pizza", FOOD), ("milk", FOOD), ("egg", FOOD),
    ("car", PLACES), ("bus", PLACES), ("truck", PLACES), ("train", PLACES), ("plane", PLACES), ("airplane", PLACES), ("ship", PLACES),
    ("boat", PLACES), ("bicycle", PLACES), ("house", PLACES), ("building", PLACES), ("city", PLACES), ("map", PLACES), ("world", PLACES), ("globe", PLACES),
    ("sun", NATURE), ("cloud", NATURE), ("rain", NATURE), ("snow*", NATURE), ("weather", NATURE), ("winter", NATURE), ("moon", NATURE),
    ("mountain", NATURE), ("landscape", NATURE), ("water", NATURE),
    ("chart", CHARTS), ("graph", CHARTS), ("plot", CHARTS), ("diagram", CHARTS), ("histogram", CHARTS),
    ("computer", COMPUTERS), ("laptop", COMPUTERS), ("phone", COMPUTERS), ("keyboard", COMPUTERS), ("monitor", COMPUTERS), ("server", COMPUTERS),
    ("arrow", ARROWS), ("line", ARROWS),
    ("circle", SHAPES), ("square", SHAPES), ("triangle", SHAPES), ("shape", SHAPES), ("polygon", SHAPES), ("hexagon", SHAPES), ("star", SHAPES),
    ("letter", TEXT), ("alphabet", TEXT), ("number", TEXT), ("digit", TEXT), ("font", TEXT),
    ("sign", SIGNS), ("symbol", SIGNS), ("warning", SIGNS), ("logo", SIGNS),
    ("shirt", CLOTHING), ("dress", CLOTHING), ("shoe", CLOTHING), ("hat", CLOTHING), ("clothes", CLOTHING), ("clothing", CLOTHING),
    ("sport", ACTIVITIES), ("ball", ACTIVITIES), ("game", ACTIVITIES), ("music", ACTIVITIES), ("guitar", ACTIVITIES), ("dance", ACTIVITIES),
    ("skating", ACTIVITIES), ("skiing", ACTIVITIES),
    ("tool", OBJECTS), ("book", OBJECTS), ("key", OBJECTS), ("clock", OBJECTS), ("lamp", OBJECTS), ("chair", OBJECTS), ("table", OBJECTS),
];

fn rules(source: &str) -> Rules {
    match source {
        "bioart" => BIOART,
        "bioicons" => BIOICONS,
        "healthicons" => HEALTHICONS,
        "openmoji" => OPENMOJI,
        "reactome" => REACTOME,
        "scidraw" => SCIDRAW,
        "servier" => SERVIER,
        _ => &[],
    }
}

/// Exact words and `*` prefixes of [`KEYWORDS`], first listed wins.
fn keyword_maps() -> &'static (HashMap<&'static str, Taxon>, HashMap<&'static str, Taxon>) {
    static MAPS: OnceLock<(HashMap<&'static str, Taxon>, HashMap<&'static str, Taxon>)> = OnceLock::new();
    MAPS.get_or_init(|| {
        let (mut exact, mut prefix) = (HashMap::new(), HashMap::new());
        for &(k, t) in KEYWORDS {
            match k.strip_suffix('*') {
                Some(p) => prefix.entry(p).or_insert(t),
                None => exact.entry(k).or_insert(t),
            };
        }
        (exact, prefix)
    })
}

/// The taxon of the first word of `text` that names one.
fn by_words(text: &str) -> Option<Taxon> {
    let (exact, prefix) = keyword_maps();
    let lower = text.to_lowercase();
    for w in lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
        let singular = w.strip_suffix("es").filter(|s| exact.contains_key(s)).or_else(|| w.strip_suffix('s'));
        if let Some(&t) = exact.get(w).or_else(|| singular.and_then(|s| exact.get(s))) {
            return Some(t);
        }
        for (i, _) in w.char_indices().skip(3).chain([(w.len(), ' ')]) {
            if let Some(&t) = prefix.get(&w[..i]) {
                return Some(t);
            }
        }
    }
    None
}

/// Words in a BioArt "Cells and Organelles" title that mean a part of a cell, not a cell.
const ORGANELLE_WORDS: &[&str] = &["mitochondri", "nucleus", "ribosome", "golgi", "reticulum", "vesicle", "lysosome", "organelle", "chromosome", "membrane"];

/// The taxa of one asset (at least one). `category` may hold several of the database's
/// categories separated by ", "; `tags` may be the raw JSON list.
pub fn classify(source: &str, category: &str, title: &str, tags: &str) -> Vec<Taxon> {
    let rules = rules(source);
    let mut out: Vec<Taxon> = Vec::new();
    let mut vague = false;
    for label in category.split(", ").map(str::trim).filter(|l| !l.is_empty()) {
        let l = label.to_lowercase();
        match rules.iter().find(|(k, _)| l.contains(k)) {
            Some((k, Some(mut t))) => {
                if source == "bioart" && *k == "cells and organelles" {
                    let tl = title.to_lowercase();
                    if ORGANELLE_WORDS.iter().any(|w| tl.contains(w)) {
                        t = ORGANELLES;
                    }
                }
                if !out.contains(&t) {
                    out.push(t);
                }
            }
            _ => vague = true,
        }
    }
    if out.is_empty() {
        // No categories, unknown ones (user uploads) or vague ones: go by the words.
        let t = by_words(title)
            .or_else(|| (vague || rules.is_empty()).then(|| by_words(category)).flatten())
            .or_else(|| by_words(tags))
            .unwrap_or(OTHER);
        out.push(t);
    }
    out
}

/// One line on what each category and subcategory of [`TAXONOMY`] holds.
const ABOUT: &[(&str, &str)] = &[
    (ANATOMY, "The body: organ systems, organs, tissues and blood"),
    (BLOOD.1, "Blood cells, antibodies, lymph and the immune system"),
    (BODY.1, "Whole bodies, organs and glands not filed under one system"),
    (CARDIO.1, "Heart, arteries, veins and vessel disease"),
    (DIGESTIVE.1, "Stomach, intestines, liver and pancreas"),
    (MUSCULO.1, "Bones, joints, skeleton and muscle"),
    (NERVOUS.1, "Brain, neurons, nerves, spinal cord and synapses"),
    (REPRO.1, "Reproductive organs, gametes, embryos and pregnancy"),
    (RESPIRATORY.1, "Lungs, airways and alveoli"),
    (SENSES.1, "Eyes, ears and skin"),
    (TISSUES.1, "Epithelia and other tissue sections"),
    (CELLS, "Cells, their parts and what happens in them"),
    (CELL_SCENES.1, "Scenes and processes: signalling, division, infection, pathways"),
    (CELL_TYPES.1, "Individual cells: neurons, T cells, stem cells, bacteria-sized drawings of cells"),
    (MEMBRANES.1, "Lipid bilayers, receptors, channels, pumps and transporters"),
    (ORGANELLES.1, "Nucleus, mitochondria, ER, Golgi, vesicles, chromosomes, cytoskeleton"),
    (DATA, "Charts, computers and computational biology"),
    (BIOINFO.1, "Sequencing data, networks, neural nets and analysis pipelines"),
    (CHARTS.1, "Plots, graphs, axes and diagrams for data"),
    (COMPUTERS.1, "Computers, phones, servers and other devices"),
    (EVERYDAY, "General-purpose pictograms that are not science"),
    (ACTIVITIES.1, "Sports, hobbies and things people do"),
    (CLOTHING.1, "Clothes and accessories"),
    (FACES.1, "Faces, expressions and emotions"),
    (FLAGS.1, "Country and other flags"),
    (FOOD.1, "Food, drink and cooking"),
    (OBJECTS.1, "Household and office objects"),
    (PLACES.1, "Buildings, maps, vehicles and travel"),
    (NATURE.1, "Weather, sky, landscapes and the environment"),
    (LAB, "The laboratory: equipment, methods and safety"),
    (IMAGING.1, "Microscopy, MRI, X-ray and ultrasound"),
    (LAB_EQUIPMENT.1, "Glassware, pipettes, tubes, plates, centrifuges and microscopes"),
    (SAFETY.1, "Hazard signs and protective equipment"),
    (TECHNIQUES.1, "Experimental methods and protocols (PCR, blotting, culture, sequencing)"),
    (MEDICINE, "Clinical medicine and health"),
    (CONDITIONS.1, "Diseases, injuries, surgery and medical specialties"),
    (DRUGS.1, "Pills, vaccines, injections and other therapeutics"),
    (MED_EQUIPMENT.1, "Hospital and clinical equipment, PPE"),
    (PUBLIC_HEALTH.1, "Epidemiology, hygiene and health services"),
    (MICROBES, "Microorganisms and pathogens"),
    (BACTERIA.1, "Bacteria and other microbes"),
    (FUNGI.1, "Yeasts, molds and mushrooms"),
    (PARASITES.1, "Protozoa, worms and other parasites"),
    (VIRUSES.1, "Viruses and phages"),
    (MOLECULES, "Molecules from small compounds to proteins"),
    (AMINO.1, "Amino acids and peptides"),
    (CHEMISTRY.1, "Atoms, small molecules, structures and reactions"),
    (LIPIDS.1, "Fatty acids, phospholipids, cholesterol"),
    (NUCLEIC.1, "DNA, RNA, genes, plasmids and genomes"),
    (PROTEINS.1, "Proteins, enzymes, antibodies as molecules"),
    (ORGANISMS, "Whole living things"),
    (ANIMALS.1, "Animals other than lab models and insects"),
    (INSECTS.1, "Insects, spiders, ticks and other arthropods"),
    (MODEL_ORGANISMS.1, "Mice, rats, zebrafish, flies, worms and other lab organisms"),
    (PLANTS.1, "Plants, trees, flowers and algae"),
    (PEOPLE, "People and parts of people"),
    (BODY_PARTS.1, "Hands, gestures and external body parts"),
    (PERSONS.1, "People, scientists, patients, clinicians and roles"),
    (SYMBOLS, "Arrows, shapes, signs and text for building figures"),
    (ARROWS.1, "Arrows, connectors and lines"),
    (SHAPES.1, "Basic shapes, bubbles and backgrounds"),
    (SIGNS.1, "Signs, symbols and icons for concepts"),
    (TEXT.1, "Letters, numbers and labels"),
    (OTHER.0, "Assets nothing else fits"),
    (OTHER.1, "Assets nothing else fits"),
];

/// What a category or subcategory of [`TAXONOMY`] holds ("" for an unknown name).
pub fn about(name: &str) -> &'static str {
    ABOUT.iter().find(|(n, _)| *n == name).map_or("", |(_, a)| a)
}

/// A name as a command-line slug: "Cell types" is `cell_types`.
pub fn slug(name: &str) -> String {
    name.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join("_")
}

/// The slug of a category (`cells`) or subcategory (`cells.cell_types`); `sub` is "" for the
/// category itself.
pub fn taxon_slug(cat: &str, sub: &str) -> String {
    if sub.is_empty() { slug(cat) } else { format!("{}.{}", slug(cat), slug(sub)) }
}

/// The category, and subcategory ("" for all of it), a slug names. Takes `cells`,
/// `cells.cell_types`, a subcategory alone (`cell_types`) or a display name ("Cell types").
pub fn resolve(s: &str) -> Option<(&'static str, &'static str)> {
    let (cat, sub) = match s.split_once('.') {
        Some((c, s)) => (slug(c), slug(s)),
        None => (slug(s), String::new()),
    };
    for (c, subs) in TAXONOMY {
        if sub.is_empty() && slug(c) == cat {
            return Some((c, ""));
        }
        for s in *subs {
            let hit = if sub.is_empty() { slug(s) == cat } else { slug(c) == cat && slug(s) == sub };
            if hit {
                return Some((c, s));
            }
        }
    }
    None
}

/// The subcategories a slug names: `cells.cell_types`, or a subcategory's slug or display name
/// alone (`cell_types`, "Cell types"), which may name a subcategory of several categories.
pub fn resolve_subcategories(s: &str) -> Vec<(&'static str, &'static str)> {
    if s.contains('.') {
        return resolve(s).filter(|(_, sub)| !sub.is_empty()).into_iter().collect();
    }
    let want = slug(s);
    TAXONOMY.iter().flat_map(|(c, subs)| subs.iter().filter(|s| slug(s) == want).map(move |s| (*c, *s))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_resolve_and_everything_is_described() {
        assert_eq!(taxon_slug(CELL_TYPES.0, CELL_TYPES.1), "cells.cell_types");
        assert_eq!(resolve("cells.cell_types"), Some(CELL_TYPES));
        assert_eq!(resolve("cell_types"), Some(CELL_TYPES));
        assert_eq!(resolve("Cell types"), Some(CELL_TYPES));
        assert_eq!(resolve("cells"), Some((CELLS, "")));
        assert_eq!(resolve("cells.viruses"), None);
        assert_eq!(resolve_subcategories("cell_types"), vec![CELL_TYPES]);
        assert_eq!(resolve_subcategories("cells.cell_types"), vec![CELL_TYPES]);
        assert!(resolve_subcategories("cells").is_empty());
        for (c, subs) in TAXONOMY {
            assert!(!about(c).is_empty(), "{c}");
            assert_eq!(resolve(&slug(c)), Some((*c, "")));
            for s in *subs {
                assert!(!about(s).is_empty(), "{s}");
                assert_eq!(resolve(&taxon_slug(c, s)), Some((*c, *s)));
            }
        }
    }

    fn known(t: Taxon) -> bool {
        TAXONOMY.iter().any(|(c, subs)| *c == t.0 && subs.contains(&t.1))
    }

    #[test]
    fn every_rule_lands_in_the_taxonomy() {
        for r in [BIOART, BIOICONS, HEALTHICONS, OPENMOJI, REACTOME, SCIDRAW, SERVIER] {
            for (k, t) in r {
                if let Some(t) = t {
                    assert!(known(*t), "{k} -> {t:?}");
                }
            }
        }
        for (k, t) in KEYWORDS {
            assert!(known(*t), "{k} -> {t:?}");
        }
    }

    #[test]
    fn taxonomy_is_alphabetical_with_other_last() {
        let cats: Vec<&str> = TAXONOMY.iter().map(|(c, _)| *c).collect();
        let (last, rest) = cats.split_last().unwrap();
        assert_eq!(*last, OTHER.0);
        assert!(rest.windows(2).all(|w| w[0].to_lowercase() < w[1].to_lowercase()), "{rest:?}");
        for (c, subs) in TAXONOMY {
            assert!(subs.windows(2).all(|w| w[0].to_lowercase() < w[1].to_lowercase()), "{c}: {subs:?}");
        }
    }

    #[test]
    fn places_assets() {
        assert_eq!(classify("bioart", "Viruses, Molecules", "SARS-CoV-2", ""), vec![VIRUSES, CHEMISTRY]);
        assert_eq!(classify("bioart", "Cells and Organelles", "Mitochondrion", ""), vec![ORGANELLES]);
        assert_eq!(classify("bioart", "Cells and Organelles", "T cell", ""), vec![CELL_TYPES]);
        assert_eq!(classify("servier", "Anatomy and The Human Body / Cardiovascular system / Blood", "Red blood cell", ""), vec![BLOOD]);
        assert_eq!(classify("servier", "", "atherosclerosis arteries overview", ""), vec![CARDIO]);
        assert_eq!(classify("openmoji", "people-body / hand-fingers-open", "waving hand", ""), vec![BODY_PARTS]);
        assert_eq!(classify("scidraw", "other", "Zebrafish larva", ""), vec![MODEL_ORGANISMS]);
        assert_eq!(classify("user", "my figures", "Neurons in culture", "[]"), vec![NERVOUS]);
        assert_eq!(classify("user", "", "snowflake1", "[\"snow\", \"winter\"]"), vec![NATURE]);
        assert_eq!(classify("user", "", "qwzx", "[]"), vec![OTHER]);
    }
}
