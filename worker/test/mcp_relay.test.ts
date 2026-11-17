import { test } from "node:test";
import assert from "node:assert/strict";
import type { Env } from "../src/env.ts";
import { viaMcp } from "../src/submit.ts";

const env = { MCP_TOKEN: "s3cret" } as unknown as Env;
const req = (token?: string) => new Request("https://api.biocartoon.com/submit", { method: "POST", headers: token === undefined ? {} : { "X-MCP-Token": token } });

test("the hosted MCP server is recognised by its token", async () => {
  assert.equal(await viaMcp(req(), env), false);
  assert.equal(await viaMcp(req("s3cret"), env), true);
  await assert.rejects(viaMcp(req("wrong"), env), /Invalid X-MCP-Token/);
  // Without the secret set, no token is accepted.
  await assert.rejects(viaMcp(req("s3cret"), {} as Env), /Invalid X-MCP-Token/);
});
