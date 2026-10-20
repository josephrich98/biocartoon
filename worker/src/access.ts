// Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) on every review request, so the
// review Worker stays closed even if Access is misconfigured or switched off. Fails closed.

import type { Env } from "./env.ts";

interface Jwk extends JsonWebKey {
  kid: string;
}

let certs: { team: string; keys: Jwk[]; fetched: number } | null = null;

async function keys(team: string): Promise<Jwk[]> {
  if (certs && certs.team === team && Date.now() - certs.fetched < 3_600_000) return certs.keys;
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  certs = { team, keys: body.keys, fetched: Date.now() };
  return body.keys;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

/** The signed-in reviewer's email, or null if the request is not from Access. */
export async function reviewer(req: Request, env: Env): Promise<string | null> {
  if (env.DEV_NO_AUTH === "1") return "local-dev";
  const team = env.ACCESS_TEAM?.trim();
  const aud = env.ACCESS_AUD?.trim();
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!team || !aud || !token) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    if (header.alg !== "RS256") return null;
    const jwk = (await keys(team)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const now = Date.now() / 1000;
    if (!ok || !auds.includes(aud) || payload.iss !== `https://${team}.cloudflareaccess.com` || !(payload.exp > now)) return null;
    return typeof payload.email === "string" ? payload.email : "access-user";
  } catch (e) {
    console.error("access check", e);
    return null;
  }
}
