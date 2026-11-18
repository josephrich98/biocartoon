// Public catalog queries for the stateless MCP Worker. D1 executes the indexed search;
// the Worker only formats a bounded set of records for the model and gallery.
import metadata from "../generated/mcp-metadata.json" with { type: "json" };

export type Args = Record<string, unknown>;
export type Row = Record<string, string | number | null>;
export const ASSETS = "https://assets.biocartoon.com";
export const text = (value: string) => ({ type: "text", text: value });
export const pretty = (value: unknown) => text(JSON.stringify(value, null, 2));
export type ToolResult = { content: Record<string, unknown>[]; structuredContent?: Record<string, unknown>; isError?: boolean };
export const str = (a: Args, key: string, fallback = "") => typeof a[key] === "string" ? (a[key] as string).trim() : fallback;
export function required(a: Args, key: string): string {
  const value = str(a, key); if (!value) throw new Error(`${key} is required`); return value;
}
export const num = (a: Args, key: string, fallback: number, max: number, min = 1) => {
  const n = a[key]; return typeof n === "number" && Number.isSafeInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
export function strings(a: Args, key: string, max = 20): string[] {
  const v = a[key]; if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || v.some(x => typeof x !== "string" || !x.trim())) throw new Error(`${key} must be an array of at most ${max} nonempty strings`);
  return v.map(x => (x as string).trim());
}
export function selectedIds(args: Args): string[] {
  const ids = strings(args, "ids", 12);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("choose 1–12 unique asset IDs");
  return ids;
}
export function assetUrl(key: unknown): string | undefined {
  if (typeof key !== "string" || !key || key.startsWith("/") || key.split("/").includes("..") || /[?#\\\u0000-\u001f]/.test(key)) return;
  return `${ASSETS}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
export function words(q: string): string[] { return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 12); }
function related(word: string): string[] {
  const forms = [word, word.replace(/s$/, ""), word.replace(/es$/, "")];
  return metadata.synonyms.filter(g => g.some(w => forms.includes(w))).flatMap(g => g).filter(w => w !== word);
}
export function ftsQuery(q: string, join = " AND "): string {
  return words(q).map(w => `(${[w, ...related(w)].map(v => `"${v.replaceAll('"', '""')}"*`).join(" OR ")})`).join(join);
}
function listJson(value: unknown): string[] {
  try { const list = JSON.parse(String(value ?? "[]")); return Array.isArray(list) ? list.filter(v => typeof v === "string") : []; } catch { return []; }
}
export function asset(row: Row, query = ""): Record<string, unknown> {
  const tags = listJson(row.tags);
  const out: Record<string, unknown> = {
    id: row.id, source: row.source, source_name: row.source_name, title: row.title ?? "", variant: row.variant ?? "",
    description: row.description ?? "", category: row.category ?? "", tags, license: row.license, credit: row.credit,
    author: row.author ?? "", width: row.png_width ?? 0, height: row.png_height ?? 0, stars: row.stars ?? 0,
    url: assetUrl(row.png_key), ...(row.svg_key ? { svg_url: assetUrl(row.svg_key) } : {}),
    ...(row.thumb_key ? { thumb_url: assetUrl(row.thumb_key) } : {}), ...(row.source_url ? { source_url: row.source_url } : {}),
  };
  const terms = words(query);
  if (terms.length) {
    const fields: Record<string, string> = { title: String(row.title ?? ""), tags: tags.join(" "), category: String(row.category ?? ""), description: String(row.description ?? "") };
    out.matched_fields = Object.entries(fields).filter(([, s]) => terms.some(t => s.toLowerCase().includes(t))).map(([key]) => key);
    out.missing_terms = terms.filter(t => !Object.values(fields).some(s => s.toLowerCase().includes(t)));
  }
  return out;
}
export function records(assets: Record<string, unknown>[], note?: string): ToolResult {
  return { content: [...(note ? [text(note)] : []), pretty(assets)], structuredContent: { assets }, isError: false };
}
export async function rows(db: D1Database, sql: string, params: (string | number)[] = []): Promise<Row[]> {
  const result = await db.prepare(sql).bind(...params).all<Row>();
  return result.results;
}
export async function getAsset(db: D1Database, id: string): Promise<Row> {
  const row = await db.prepare("SELECT * FROM assets WHERE id = ?").bind(id).first<Row>();
  if (!row) throw new Error(`no asset ${id}`); return row;
}
function sourceFilter(sources: string[], params: (string | number)[]): string {
  if (!sources.length) return "";
  return " AND (" + sources.map(s => {
    if (s === "biocartoon") return "(a.source='user' AND (lower(a.source_name)='biocartoon' OR a.author='BioCartoon'))";
    params.push(s); return "a.source = ?";
  }).join(" OR ") + ")";
}
function order(sort: string, searching = false): string {
  if (["za", "z-a", "reverse"].includes(sort)) return "a.title COLLATE NOCASE DESC, a.id";
  if (["popular", "popularity"].includes(sort)) return "a.stars DESC, a.title COLLATE NOCASE, a.id";
  if (["az", "a-z", "alphabetical"].includes(sort) || !searching) return "a.title COLLATE NOCASE, a.id";
  return "bm25(assets_fts, 10.0, 1.0, 3.0, 1.0, 0.5), a.id";
}
async function search(db: D1Database, args: Args): Promise<ToolResult> {
  const query = str(args, "query"); if (query.length > 200) throw new Error("query must be at most 200 characters");
  const sources = strings(args, "sources"), tags = strings(args, "tags"), limit = num(args, "limit", 12, 60);
  const run = async (match: string) => {
    const params: (string | number)[] = match ? [match] : [];
    let where = "a.png_key IS NOT NULL AND coalesce(a.dup,0)=0" + sourceFilter(sources, params);
    if (tags.length) { where += ` AND EXISTS (SELECT 1 FROM json_each(a.tags) t WHERE lower(t.value) IN (${tags.map(() => "?").join(",")}))`; params.push(...tags.map(t => t.toLowerCase())); }
    const from = match ? "assets_fts JOIN assets a ON a.rowid = assets_fts.rowid" : "assets a";
    const hits = await rows(db, `SELECT a.* FROM ${from} WHERE ${match ? "assets_fts MATCH ? AND " : ""}${where} ORDER BY ${order(str(args, "sort"), !!match)} LIMIT ?`, [...params, Math.min(360, limit * 6)]);
    const seen = new Set();
    return hits.filter(a => { const key = a.grp || a.id; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, limit);
  };
  const match = ftsQuery(query);
  let hits = await run(match);
  if (!hits.length && words(query).length > 1) hits = await run(ftsQuery(query, " OR "));
  return records(hits.map(a => asset(a, query)), hits.length ? `${hits.length} closest matches for ${JSON.stringify(query)}. Judge titles, tags and pictures before recommending a match.` : `No illustrations found for ${JSON.stringify(query)}. Try fewer words or a synonym.`);
}

/** Keep sql_query strictly read-only, including WITH, quoted text and trailing comments.
 * The catalog is a separate public database and never has access to submission/account tables. */
export function readOnlySql(sql: string): string {
  if (!sql || sql.length > 10_000) throw new Error("SQL must be one SELECT or WITH statement, at most 10,000 characters");
  const lexer = /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|;|[^\s]/g;
  const tokens = sql.match(lexer) ?? [];
  const code = tokens.filter(t => !t.startsWith("--") && !t.startsWith("/*"));
  if (code.at(-1) === ";") code.pop();
  if (!/^(SELECT|WITH)$/i.test(code[0] ?? "") || code.includes(";") || code.some(t => /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|load_extension|readfile|writefile)$/i.test(t))) throw new Error("only a single read-only SELECT or WITH statement is allowed");
  // Strip comments without changing whitespace or multi-character operators such as || and >=.
  // A final -- must not swallow the wrapper's closing bracket.
  return sql.replace(lexer, token => token.startsWith("--") || token.startsWith("/*") ? " " : token).trim().replace(/;$/, "");
}

export async function catalogTool(db: D1Database, name: string, args: Args): Promise<ToolResult> {
  switch (name) {
    case "search_assets": return search(db, args);
    case "get_asset": { const a = asset(await getAsset(db, required(args, "id"))); return { content: [pretty(a)], structuredContent: { asset: a }, isError: false }; }
    case "render_assets": {
      const ids = selectedIds(args);
      const found = await rows(db, `SELECT * FROM assets WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      const ordered = ids.map(id => { const a = found.find(a => a.id === id); if (!a) throw new Error(`no asset ${id}`); return asset(a); });
      return records(ordered, "Selected BioCartoon illustrations. Use each illustration's original license and credit line.");
    }
    case "asset_variants": {
      const a = await getAsset(db, required(args, "id"));
      const hits = await rows(db, "SELECT * FROM assets WHERE png_key IS NOT NULL AND coalesce(dup,0)=0 AND (grp=? OR style_group=?) ORDER BY variant, id LIMIT 40", [String(a.grp || a.id), String(a.style_group || a.id)]);
      return records(hits.map(a => asset(a)));
    }
    case "browse_assets": {
      const params: (string | number)[] = [];
      let where = "a.png_key IS NOT NULL AND coalesce(a.dup,0)=0" + sourceFilter([required(args, "source")], params);
      if (str(args, "category")) { where += " AND a.category=?"; params.push(str(args, "category")); }
      const hits = await rows(db, `SELECT a.*, min(CASE WHEN coalesce(a.variant,'')='' THEN 0 ELSE 1 END) AS preference FROM assets a WHERE ${where} GROUP BY coalesce(a.grp,a.id) ORDER BY ${order("az")} LIMIT ? OFFSET ?`, [...params, num(args, "limit", 40, 200), num(args, "offset", 0, 100_000, 0)]);
      return records(hits.map(a => asset(a)));
    }
    case "list_sources": return { content: [pretty(await rows(db, "SELECT source, source_name AS name, count(DISTINCT grp) AS count, group_concat(DISTINCT license) AS licenses FROM assets WHERE coalesce(dup,0)=0 GROUP BY source, source_name ORDER BY source_name"))] };
    case "list_categories": {
      const params: (string | number)[] = [];
      const filter = sourceFilter([required(args, "source")], params);
      return { content: [pretty(await rows(db, `SELECT category AS name, count(DISTINCT grp) AS count FROM assets a WHERE coalesce(a.dup,0)=0 ${filter} GROUP BY category ORDER BY category`, params))] };
    }
    case "sql_query": {
      const limit = num(args, "max_rows", 100, 1000);
      const sql = readOnlySql(required(args, "sql"));
      const raw = await db.prepare(`SELECT * FROM (${sql}) LIMIT ${limit + 1}`).raw<unknown[]>({ columnNames: true });
      const [columns = [], ...data] = raw;
      return { content: [pretty({ columns, rows: data.slice(0, limit), truncated: data.length > limit })] };
    }
    case "db_schema": return { content: [pretty(await rows(db, "SELECT name, sql FROM sqlite_schema WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT GLOB 'assets_fts_*' ORDER BY name"))] };
    case "list_templates": {
      const query = words(str(args, "query"));
      const found = await rows(db, "SELECT * FROM templates ORDER BY created_at DESC, title LIMIT 500");
      const hits = found.filter(t => query.every(w => `${t.title} ${t.description} ${t.category} ${t.tags}`.toLowerCase().includes(w))).map(template);
      return { content: [pretty(hits)], structuredContent: { templates: hits } };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}
export function template(row: Row): Record<string, unknown> {
  return { id: row.id, title: row.title ?? "", description: row.description ?? "", category: row.category ?? "", tags: listJson(row.tags), author: row.author ?? "", license: row.license ?? "", created_at: row.created_at ?? "", generative_ai_used: row.generative_ai_used === null ? null : !!row.generative_ai_used, json_url: assetUrl(row.json_key), ...(row.thumb_key ? { thumb_url: assetUrl(row.thumb_key) } : {}) };
}
