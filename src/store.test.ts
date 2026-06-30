import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";

const tmpDirs: string[] = [];
function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "arcana-store-"));
  tmpDirs.push(dir);
  return join(dir, "state.json");
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("Store", () => {
  it("ratchets the floor up and never down", () => {
    const s = new Store();
    expect(s.floorRank("c1")).toBe(-1);
    s.commit("c1", { rank: 0, model: "flash", route: "general" });
    expect(s.floorRank("c1")).toBe(0);
    s.commit("c1", { rank: 2, model: "opus", route: "heavy" });
    expect(s.floorRank("c1")).toBe(2);
    s.commit("c1", { rank: 0, model: "flash", route: "general" }); // would downgrade
    expect(s.floorRank("c1")).toBe(2);
  });

  it("aggregates stats by route and model", () => {
    const s = new Store();
    s.commit("c1", { rank: 0, model: "flash", route: "general" });
    s.commit("c2", { rank: 1, model: "midcoder", route: "coding" });
    s.commit("c2", { rank: 1, model: "midcoder", route: "coding" });
    s.commit("", { rank: 2, model: "opus", route: "heavy" }); // anonymous
    const st = s.stats();
    expect(st.totalRoutes).toBe(4);
    expect(st.activeConversations).toBe(2);
    expect(st.byRoute["coding"]).toBe(2);
    expect(st.byModel["opus"]).toBe(1);
  });

  it("persists pins + stats across restarts (survives a new Store)", () => {
    const path = tmpStatePath();
    const s1 = new Store({ path });
    s1.commit("c1", { rank: 2, model: "opus", route: "heavy" });
    s1.commit("c2", { rank: 1, model: "midcoder", route: "coding" });
    s1.flush();
    expect(existsSync(path)).toBe(true);

    // Simulate a restart: a fresh Store reading the same file.
    const s2 = new Store({ path });
    expect(s2.floorRank("c1")).toBe(2); // ratchet survived — no silent downgrade
    expect(s2.floorRank("c2")).toBe(1);
    expect(s2.stats().totalRoutes).toBe(2);
    expect(s2.stats().byRoute["heavy"]).toBe(1);
  });

  it("evicts pins idle longer than the TTL on load", () => {
    const path = tmpStatePath();
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        startedAt: old,
        total: 1,
        byRoute: { heavy: 1 },
        byModel: { opus: 1 },
        pins: { stale: { rank: 2, model: "opus", route: "heavy", updatedAt: old } },
      }),
    );
    const s = new Store({ path, ttlMs: 14 * 24 * 60 * 60 * 1000 });
    expect(s.floorRank("stale")).toBe(-1); // pruned
    expect(s.stats().totalRoutes).toBe(1); // counters still restored
  });

  it("stays in-memory (no file) when no path is given", () => {
    const s = new Store();
    s.commit("c1", { rank: 1, model: "midcoder", route: "coding" });
    expect(s.floorRank("c1")).toBe(1);
  });
});
