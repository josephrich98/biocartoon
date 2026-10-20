import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewer } from "../src/access.ts";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function setup() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const other = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch;
  const sign = async (payload: object, key = pair.privateKey) => {
    const data = `${enc({ alg: "RS256", kid: "k1" })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { sign, other };
}

const env = { ACCESS_TEAM: "team", ACCESS_AUD: "aud1" } as any;
const req = (token?: string) => new Request("https://r.example/", { headers: token ? { "cf-access-jwt-assertion": token } : {} });
const good = { aud: ["aud1"], iss: "https://team.cloudflareaccess.com", exp: Date.now() / 1000 + 600, email: "me@example.com" };

test("access tokens", async () => {
  const { sign, other } = await setup();
  assert.equal(await reviewer(req(await sign(good)), env), "me@example.com");
  assert.equal(await reviewer(req(), env), null, "no token");
  assert.equal(await reviewer(req(await sign(good, other.privateKey)), env), null, "forged signature");
  assert.equal(await reviewer(req(await sign({ ...good, aud: ["other"] })), env), null, "wrong audience");
  assert.equal(await reviewer(req(await sign({ ...good, iss: "https://evil.cloudflareaccess.com" })), env), null, "wrong issuer");
  assert.equal(await reviewer(req(await sign({ ...good, exp: 1 })), env), null, "expired");
  assert.equal(await reviewer(req(await sign(good)), { ACCESS_TEAM: "", ACCESS_AUD: "" } as any), null, "unconfigured fails closed");
  assert.equal(await reviewer(req(), { DEV_NO_AUTH: "1" } as any), "local-dev");
});
