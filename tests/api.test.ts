import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { makeHarness, type Harness } from "./helpers.ts";
import { createApiServer } from "../src/api/http.ts";
import type { Server } from "node:http";

let h: Harness;
let server: Server;
let base: string;

beforeEach(async () => {
  h = makeHarness();
  server = createApiServer(h.ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  h.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

const screeningBody = () => ({
  trialCode: "FICT-042",
  siteCode: "BJ01",
  strata: { age_band: "<65", disease_stage: "II" },
  criteria: { inclusion_age: true, inclusion_diagnosis: true, exclusion_pregnancy: true },
  consentSignedAt: new Date(h.clock.now().getTime() - 86_400_000).toISOString(),
});

describe("HTTP API", () => {
  it("serves health without auth", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
  });

  it("requires auth headers and validates input", async () => {
    const noauth = await call("POST", "/screenings", screeningBody());
    expect(noauth.status).toBe(401);
    expect((noauth.json.error as { code: string }).code).toBe("FORBIDDEN");

    const bad = await call("POST", "/screenings", { ...screeningBody(), siteCode: "!!" }, {
      "x-operator": "fic-coord", "x-role": "coordinator",
    });
    expect(bad.status).toBe(422);

    const malformed = await fetch(base + "/screenings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator": "fic-coord", "x-role": "coordinator" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("full flow: screen -> masked allocate -> forbidden unblind -> admin unblind", async () => {
    const coord = { "x-operator": "api-coord", "x-role": "coordinator" };
    const admin = { "x-operator": "api-admin", "x-role": "unblinded_admin" };

    const screen = await call("POST", "/screenings", screeningBody(), coord);
    expect(screen.status).toBe(201);
    const subjectId = (screen.json as { subjectId: string }).subjectId;

    const alloc = await call("POST", `/subjects/${subjectId}/allocate`, undefined, coord);
    expect(alloc.status).toBe(201);
    expect((alloc.json as { arm?: string }).arm).toBeUndefined();

    const blocked = await call("POST", `/subjects/${subjectId}/unblind`, { reason: "emergency", justification: "x" }, coord);
    expect(blocked.status).toBe(403);

    const revealed = await call("POST", `/subjects/${subjectId}/unblind`, { reason: "emergency", justification: "fictional emergency" }, admin);
    expect(revealed.status).toBe(201);
    expect(["A", "B"]).toContain((revealed.json as { arm: string }).arm);

    const visible = await call("GET", `/subjects/${subjectId}/allocation`, undefined, admin);
    expect((visible.json as Record<string, unknown>).arm).toBeDefined();
    const masked = await call("GET", `/subjects/${subjectId}/allocation`, undefined, coord);
    expect((masked.json as Record<string, unknown>).arm).toBeUndefined();
  });

  it("paginates subjects and deviations", async () => {
    const coord = { "x-operator": "p-coord", "x-role": "coordinator" };
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", "/screenings", screeningBody(), coord);
      expect(r.status).toBe(201);
    }
    const page = await call("GET", "/subjects?limit=2&offset=0", undefined, coord);
    expect(page.status).toBe(200);
    expect((page.json as { data: unknown[] }).data).toHaveLength(2);
    expect((page.json as { total: number }).total).toBe(3);
    const page2 = await call("GET", "/subjects?limit=2&offset=2", undefined, coord);
    expect((page2.json as { data: unknown[] }).data).toHaveLength(1);
    const badPaging = await call("GET", "/subjects?limit=abc", undefined, coord);
    expect(badPaging.status).toBe(422);
  });

  it("auditor-only endpoints are protected and chain verifies", async () => {
    const coord = { "x-operator": "a-coord", "x-role": "coordinator" };
    const auditor = { "x-operator": "a-auditor", "x-role": "auditor" };
    expect((await call("GET", "/audit/verify", undefined, coord)).status).toBe(403);
    const verified = await call("GET", "/audit/verify", undefined, auditor);
    expect(verified.status).toBe(200);
    expect((verified.json as { ok: boolean }).ok).toBe(true);
  });

  it("returns clear error codes for domain conflicts", async () => {
    const coord = { "x-operator": "c-coord", "x-role": "coordinator" };
    const r = await call("POST", "/screenings", {
      ...screeningBody(),
      criteria: { inclusion_age: false },
    }, coord);
    const subjectId = (r.json as { subjectId: string }).subjectId;
    const alloc = await call("POST", `/subjects/${subjectId}/allocate`, undefined, coord);
    expect(alloc.status).toBe(403);
    expect((alloc.json.error as { code: string }).code).toBe("FORBIDDEN");
    expect((await call("GET", "/nope")).status).toBe(404);
  });

  it("serializes concurrent allocations without duplicate sequence numbers", async () => {
    const coord = { "x-operator": "x-coord", "x-role": "coordinator" };
    const subjectIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await call("POST", "/screenings", screeningBody(), coord);
      subjectIds.push((r.json as { subjectId: string }).subjectId);
    }
    const results = await Promise.all(subjectIds.map((id) => call("POST", `/subjects/${id}/allocate`, undefined, coord)));
    for (const r of results) expect(r.status).toBe(201);
    const indices = (h.ctx.db.prepare(
      "SELECT sequence_index FROM allocations ORDER BY sequence_index",
    ).all() as { sequence_index: number }[]).map((r) => r.sequence_index);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
