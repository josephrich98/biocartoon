//! The search box's advanced syntax: `field:value` terms (`author:smith`, `license:"CC BY"`) and
//! boolean logic in capitals (`AND`, `OR`, `NOT`, parentheses). A query with none of these is a
//! plain keyword search ([`parse`] returns `None`), so the search treats it as it always has.
//!
//! Precedence is `NOT` over `AND` over `OR`; words next to each other are `AND`-ed. Field values
//! match a part of the field in any case (`category:cell` finds "Cells"), except `id` (the whole
//! id) and `file_type` (`svg`, or `png` for a PNG only). Unfinished input (a trailing `AND`, an
//! unclosed parenthesis, `author:` with nothing after it) is forgiven, so the results don't vanish
//! while a query is being typed.

/// A field a term can name. Each has its canonical name first, then aliases.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Database,
    Author,
    Category,
    Subcategory,
    DatabaseCategory,
    License,
    FileType,
    Tags,
    Id,
}

impl Field {
    pub const ALL: [(Field, &'static [&'static str]); 9] = [
        (Field::Database, &["database", "db", "source"]),
        (Field::Author, &["author"]),
        (Field::Category, &["category", "cat"]),
        (Field::Subcategory, &["subcategory", "subcat"]),
        (Field::DatabaseCategory, &["database_category", "db_category", "dbcat"]),
        (Field::License, &["license", "licence"]),
        (Field::FileType, &["file_type", "filetype", "type", "format"]),
        (Field::Tags, &["tags", "tag"]),
        (Field::Id, &["id"]),
    ];

    /// The field a name before a colon refers to, in any case, `-` or `_` between words.
    pub fn from_name(name: &str) -> Option<Field> {
        let name = name.to_lowercase().replace('-', "_");
        Self::ALL.iter().find(|(_, names)| names.contains(&name.as_str())).map(|(f, _)| *f)
    }

    pub fn name(self) -> &'static str {
        Self::ALL.iter().find(|(f, _)| *f == self).map(|(_, n)| n[0]).unwrap_or("")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// Keywords, searched as the plain search searches them (every word must match).
    Words(String),
    /// A quoted phrase: its words together, in order.
    Phrase(String),
    /// `field:value`, the value lowercased.
    Field(Field, String),
    Not(Box<Expr>),
    And(Vec<Expr>),
    Or(Vec<Expr>),
}

impl Expr {
    /// Whether a record passes, `leaf` deciding each `Words`, `Phrase` and `Field` term.
    pub fn eval(&self, leaf: &dyn Fn(&Expr) -> bool) -> bool {
        match self {
            Expr::Not(e) => !e.eval(leaf),
            Expr::And(v) => v.iter().all(|e| e.eval(leaf)),
            Expr::Or(v) => v.iter().any(|e| e.eval(leaf)),
            e => leaf(e),
        }
    }

    /// The keywords and phrases the query looks for (not under a `NOT`), for ranking matches.
    pub fn wanted_words(&self) -> Vec<&Expr> {
        match self {
            Expr::Words(_) | Expr::Phrase(_) => vec![self],
            Expr::And(v) | Expr::Or(v) => v.iter().flat_map(Expr::wanted_words).collect(),
            Expr::Not(_) | Expr::Field(..) => Vec::new(),
        }
    }
}

/// A part of a value in any case, as `Field` terms other than `id` and `file_type` match.
pub fn contains(haystack: &str, value: &str) -> bool {
    haystack.to_lowercase().contains(value)
}

/// Whether a `file_type` value fits an asset: `svg` one published as SVG, `png` one published as a
/// PNG only (as the file type filter has it).
pub fn file_type_matches(value: &str, has_svg: bool) -> bool {
    match value.trim_start_matches('.') {
        "svg" => has_svg,
        "png" => !has_svg,
        _ => false,
    }
}

/// Whether text (a record's title, description, category and tags, joined) has a `Words` or
/// `Phrase` term: each word in it (`Words`), or the phrase (`Phrase`), in any case.
pub fn text_matches(text: &str, e: &Expr) -> bool {
    let text = text.to_lowercase();
    match e {
        Expr::Words(w) => w.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).all(|w| text.contains(&w.to_lowercase())),
        Expr::Phrase(p) => text.contains(&p.to_lowercase()),
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Word(String),
    Phrase(String),
    Field(Field, String),
    And,
    Or,
    Not,
    Open,
    Close,
}

fn tokenize(q: &str) -> Vec<Token> {
    let chars: Vec<char> = q.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    // A value in quotes runs to the closing quote (or the end); otherwise to a space or parenthesis.
    let read = |i: &mut usize| -> String {
        let start;
        if chars.get(*i) == Some(&'"') {
            start = *i + 1;
            *i = start;
            while *i < chars.len() && chars[*i] != '"' {
                *i += 1;
            }
            let s: String = chars[start..*i].iter().collect();
            *i += 1;
            return s;
        }
        start = *i;
        while *i < chars.len() && !chars[*i].is_whitespace() && !matches!(chars[*i], '(' | ')' | '"') {
            *i += 1;
        }
        chars[start..*i].iter().collect()
    };
    while i < chars.len() {
        match chars[i] {
            c if c.is_whitespace() => i += 1,
            '(' => {
                out.push(Token::Open);
                i += 1;
            }
            ')' => {
                out.push(Token::Close);
                i += 1;
            }
            '"' => {
                let p = read(&mut i);
                if !p.trim().is_empty() {
                    out.push(Token::Phrase(p.trim().to_string()));
                }
            }
            _ => {
                let start = i;
                while i < chars.len() && !chars[i].is_whitespace() && !matches!(chars[i], '(' | ')' | '"' | ':') {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                if chars.get(i) == Some(&':') {
                    if let Some(field) = Field::from_name(&word) {
                        i += 1;
                        let value = read(&mut i);
                        let mut value = value.trim().to_lowercase();
                        // Categories are named in words; their slugs (`cell_types`) work too.
                        if matches!(field, Field::Category | Field::Subcategory) {
                            value = value.replace('_', " ");
                        }
                        // `author:` with nothing after it yet: no term.
                        if !value.is_empty() {
                            out.push(Token::Field(field, value));
                        }
                        continue;
                    }
                    // Not a field ("covid:19"): the colon and what follows are part of the word.
                    let rest = read(&mut i);
                    out.push(Token::Word(word + &rest));
                    continue;
                }
                out.push(match word.as_str() {
                    "AND" => Token::And,
                    "OR" => Token::Or,
                    "NOT" => Token::Not,
                    _ => Token::Word(word),
                });
            }
        }
    }
    out
}

/// The query as an expression, or `None` for a plain keyword search (no field, operator or
/// parenthesis) or one with no terms.
pub fn parse(q: &str) -> Option<Expr> {
    let tokens = tokenize(q);
    if !tokens.iter().any(|t| !matches!(t, Token::Word(_))) {
        return None;
    }
    let mut p = Parser { tokens, pos: 0 };
    let mut terms = Vec::new();
    // Stray closing parentheses end `or` early; skip them and go on.
    while p.pos < p.tokens.len() {
        if let Some(e) = p.or() {
            terms.push(e);
        } else {
            p.pos += 1;
        }
    }
    and_of(terms)
}

fn and_of(mut v: Vec<Expr>) -> Option<Expr> {
    match v.len() {
        0 => None,
        1 => v.pop(),
        _ => Some(Expr::And(v)),
    }
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn or(&mut self) -> Option<Expr> {
        let mut v: Vec<Expr> = self.and().into_iter().collect();
        while self.peek() == Some(&Token::Or) {
            self.pos += 1;
            v.extend(self.and());
        }
        match v.len() {
            0 => None,
            1 => v.pop(),
            _ => Some(Expr::Or(v)),
        }
    }

    fn and(&mut self) -> Option<Expr> {
        let mut v = Vec::new();
        loop {
            match self.peek() {
                None | Some(Token::Or) | Some(Token::Close) => break,
                Some(Token::And) => self.pos += 1,
                _ => v.extend(self.unary()),
            }
        }
        // Words next to each other are one `Words` term, searched as the plain search would.
        let mut merged: Vec<Expr> = Vec::new();
        for e in v {
            match (merged.last_mut(), e) {
                (Some(Expr::Words(a)), Expr::Words(b)) => {
                    a.push(' ');
                    a.push_str(&b);
                }
                (_, e) => merged.push(e),
            }
        }
        and_of(merged)
    }

    fn unary(&mut self) -> Option<Expr> {
        let t = self.peek()?.clone();
        self.pos += 1;
        match t {
            Token::Not => self.unary().map(|e| Expr::Not(Box::new(e))),
            Token::Open => {
                let e = self.or();
                if self.peek() == Some(&Token::Close) {
                    self.pos += 1;
                }
                e
            }
            Token::Word(w) => Some(Expr::Words(w)),
            Token::Phrase(p) => Some(Expr::Phrase(p)),
            Token::Field(f, v) => Some(Expr::Field(f, v)),
            Token::And | Token::Or | Token::Close => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Expr {
        Expr::Words(s.into())
    }

    fn f(field: Field, v: &str) -> Expr {
        Expr::Field(field, v.into())
    }

    #[test]
    fn plain_queries_are_not_parsed() {
        assert_eq!(parse("red blood cell"), None);
        assert_eq!(parse("cells and tissues"), None);
        assert_eq!(parse("covid:19"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn fields() {
        assert_eq!(parse("database:Servier"), Some(f(Field::Database, "servier")));
        assert_eq!(parse("author:\"Jane Doe\" neuron"), Some(Expr::And(vec![f(Field::Author, "jane doe"), w("neuron")])));
        assert_eq!(parse("Database_Category:viruses"), Some(f(Field::DatabaseCategory, "viruses")));
        assert_eq!(parse("file-type:svg"), Some(f(Field::FileType, "svg")));
        assert_eq!(parse("author: mouse"), None);
    }

    #[test]
    fn boolean_logic() {
        assert_eq!(
            parse("mouse brain OR rat NOT tag:old"),
            Some(Expr::Or(vec![w("mouse brain"), Expr::And(vec![w("rat"), Expr::Not(Box::new(f(Field::Tags, "old")))])]))
        );
        assert_eq!(
            parse("(cat:cells OR cat:tissues) AND license:cc0"),
            Some(Expr::And(vec![Expr::Or(vec![f(Field::Category, "cells"), f(Field::Category, "tissues")]), f(Field::License, "cc0")]))
        );
        assert_eq!(parse("neuron AND"), Some(w("neuron")));
        assert_eq!(parse("(neuron OR glia"), Some(Expr::Or(vec![w("neuron"), w("glia")])));
        assert_eq!(parse("neuron) glia"), Some(Expr::And(vec![w("neuron"), w("glia")])));
        assert_eq!(parse("\"red blood\" cell"), Some(Expr::And(vec![Expr::Phrase("red blood".into()), w("cell")])));
    }

    #[test]
    fn eval() {
        let e = parse("neuron NOT author:smith").unwrap();
        let rec = |author: &'static str| move |e: &Expr| match e {
            Expr::Field(Field::Author, v) => contains(author, v),
            e => text_matches("Neuron cell", e),
        };
        assert!(e.eval(&rec("Ann Jones")));
        assert!(!e.eval(&rec("John Smith")));
    }
}
