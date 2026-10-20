import { test } from "node:test";
import assert from "node:assert/strict";
import { b64url, callback, cookie, returnUrl, start, unb64url, validProjectId } from "../src/accounts.ts";

const env = { APP_ORIGINS: "https://app.biocartoon.com, http://localhost:8080", GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret" } as any;

test("sign-in only returns to the app", () => {
  assert.equal(returnUrl("https://app.biocartoon.com/", env), "https://app.biocartoon.com/");
  assert.equal(returnUrl("https://app.biocartoon.com/?x=1#old", env), "https://app.biocartoon.com/?x=1", "fragment dropped");
  assert.equal(returnUrl("http://localhost:8080/", env), "http://localhost:8080/");
  for (const bad of [null, "", "not a url", "https://evil.example/", "https://app.biocartoon.com.evil.example/", "http://app.biocartoon.com/", "javascript:alert(1)"]) {
    assert.equal(returnUrl(bad, env), null, String(bad));
  }
  assert.equal(returnUrl("https://app.biocartoon.com/", {} as any), "https://app.biocartoon.com/", "default origin");
});

test("project ids are UUIDs", () => {
  assert.ok(validProjectId("0f8fad5b-d9cb-469f-a165-70867728950e"));
  for (const bad of ["", "..", "0F8FAD5B-D9CB-469F-A165-70867728950E", "0f8fad5b-d9cb-469f-a165-70867728950e/x", "abc"]) assert.equal(validProjectId(bad), false, bad);
});

test("cookies and base64url", () => {
  const req = new Request("https://api.example/", { headers: { cookie: "a=1; __Host-biocartoon_oauth=s.v.r==; b=2" } });
  assert.equal(cookie(req, "__Host-biocartoon_oauth"), "s.v.r==");
  assert.equal(cookie(req, "missing"), null);
  for (const s of ["https://app.biocartoon.com/?q=ünïcode", ""]) assert.equal(unb64url(b64url(s)), s);
  assert.ok(!/[+/=]/.test(b64url("~~~???>>>")));
});

test("start sends the browser to Google with state and PKCE", async () => {
  const res = await start(new URL("https://api.example/auth/google/start?return=https://app.biocartoon.com/"), "google", env);
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location")!);
  assert.equal(to.origin, "https://accounts.google.com");
  assert.equal(to.searchParams.get("redirect_uri"), "https://api.example/auth/google/callback");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  const set = res.headers.get("set-cookie")!;
  assert.match(set, /HttpOnly; Secure; SameSite=Lax/);
  const [state, , ret] = set.split(";")[0].split("=")[1].split(".");
  assert.equal(state, to.searchParams.get("state"));
  assert.equal(unb64url(ret), "https://app.biocartoon.com/");
  await assert.rejects(start(new URL("https://api.example/auth/google/start?return=https://evil.example/"), "google", env), /Unknown return address/);
  await assert.rejects(start(new URL("https://api.example/auth/github/start?return=https://app.biocartoon.com/"), "github", env), /isn't set up/);
});

test("callback refuses a state it didn't issue", async () => {
  const value = `good.verifier.${b64url("https://app.biocartoon.com/")}`;
  const req = (state: string, withCookie = true) =>
    new Request(`https://api.example/auth/google/callback?code=c&state=${state}`, { headers: withCookie ? { cookie: `__Host-biocartoon_oauth=${value}` } : {} });
  for (const r of [req("forged"), req("good", false)]) {
    const res = await callback(r, new URL(r.url), "google", env);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null, "no redirect anywhere");
  }
  // The user cancelling at Google goes back to the app with a message.
  const r = new Request("https://api.example/auth/google/callback?error=access_denied&state=good", { headers: { cookie: `__Host-biocartoon_oauth=${value}` } });
  const res = await callback(r, new URL(r.url), "google", env);
  assert.equal(res.headers.get("location"), "https://app.biocartoon.com/#biocartoon_error=Sign-in%20was%20cancelled");
});
