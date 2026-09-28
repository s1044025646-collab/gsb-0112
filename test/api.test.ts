import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { openDb, type DB } from "../src/db.js";
import { createApp } from "../src/api.js";
import { mutableClock } from "../src/context.js";

let server: Server;
let base: string;
let db: DB;

before(async () => {
  db = openDb(":memory:");
  const app = createApp(db, mutableClock("2026-01-05T01:00:00Z").ctx);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as any;
  base = "http://127.0.0.1:" + addr.port;
});

after(() => {
  server.close();
  db.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test("API: validation errors carry code VALIDATION_ERROR", async () => {
  const r = await post("/trials", { code: "" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "VALIDATION_ERROR");
});

test("API: full flow with error codes and pagination", async () => {
  const t = await post("/trials", { code: "API-1", title: "T", arms: ["X", "Y"], blockSize: 4, actor: "a" });
  assert.equal(t.status, 201);
  const trialId = t.body.id;

  await post("/trials/" + trialId + "/protocol-versions", {
    version: "v1", effectiveFrom: "2026-01-01T00:00:00Z",
    visitWindows: [{ name: "V1", target_day: 7, minus_days: 2, plus_days: 2 }], actor: "a",
  });
  const site = await post("/trials/" + trialId + "/sites", { code: "S1", name: "S", timezone: "Asia/Shanghai", actor: "a" });
  const siteId = site.body.id;

  await post("/users", { name: "ubi", role: "unblinded" });
  await post("/users", { name: "bli", role: "blinded" });

  const mk = async (anon: string) => {
    const s = await post("/subjects", { trialId, siteId, anonCode: anon, stratum: { age: "lt65" }, actor: "a" });
    const id = s.body.id;
    await post("/subjects/" + id + "/screening", { criteria: {}, eligible: true, actor: "a" });
    await post("/subjects/" + id + "/consent", { consentVersion: "ICF-1", actor: "a" });
    return id;
  };
  const ids = [await mk("API-A1"), await mk("API-A2"), await mk("API-A3")];

  // assign without consent -> 422 CONSENT_MISSING
  const noConsent = await post("/subjects", { trialId, siteId, anonCode: "API-NC", stratum: {}, actor: "a" });
  await post("/subjects/" + noConsent.body.id + "/screening", { criteria: {}, eligible: true, actor: "a" });
  const refused = await post("/subjects/" + noConsent.body.id + "/assign", { actor: "a" });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "CONSENT_MISSING");

  for (const id of ids) {
    const r = await post("/subjects/" + id + "/assign", { actor: "a" });
    assert.equal(r.status, 201);
  }

  // blinded role cannot read arm
  const denied = await fetch(base + "/subjects/" + ids[0] + "/arm", { headers: { "x-actor": "bli" } });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as any).error.code, "FORBIDDEN_BLINDED_ROLE");

  const allowed = await fetch(base + "/subjects/" + ids[0] + "/arm", { headers: { "x-actor": "ubi" } });
  assert.equal(allowed.status, 200);

  // pagination
  const page = await fetch(base + "/subjects?limit=2&offset=0", { headers: { "x-actor": "ubi" } });
  const pj = (await page.json()) as any;
  assert.equal(pj.data.length, 2);
  assert.equal(pj.meta.total, 4);
  assert.equal(pj.meta.limit, 2);

  // blinded listing hides arm column
  const blindList = await fetch(base + "/subjects", { headers: { "x-actor": "bli" } });
  const bl = (await blindList.json()) as any;
  assert.ok(!("arm" in bl.data[0]), "blinded listing must not expose arm");

  // 404 code
  const nf = await post("/subjects/9999/assign", { actor: "a" });
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, "NOT_FOUND");

  // audit summary endpoint
  const sum = (await (await fetch(base + "/audit/summary")).json()) as any;
  assert.equal(sum.chains.main.intact, true);
});
