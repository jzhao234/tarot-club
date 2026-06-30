import { describe, it, expect } from "vitest";
import { ArcanaRouter } from "./router";
import type { Embedder } from "./embedder";
import type { RouteDef } from "./routes";

// FakeEmbedder maps a tiny vocabulary to one-hot vectors so routing is
// deterministic without loading the real model. "alpha"→general,
// "bravo"→coding, "charlie"→heavy.
class FakeEmbedder implements Embedder {
  private vocab = ["alpha", "bravo", "charlie"];
  async embed(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    const v: number[] = this.vocab.map((t) => (lower.includes(t) ? 1 : 0));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

const testRoutes: RouteDef[] = [
  { id: "general", model: "flash", tier: "general", rank: 0, vision: true, examples: ["alpha"] },
  { id: "coding", model: "midcoder", tier: "coding", rank: 1, vision: false, examples: ["bravo"] },
  { id: "heavy", model: "opus", tier: "heavy", rank: 2, vision: true, examples: ["charlie"] },
];

function newRouter() {
  return new ArcanaRouter(new FakeEmbedder(), testRoutes);
}

describe("ArcanaRouter.resolve", () => {
  it("routes by meaning to the matching route", async () => {
    const r = newRouter();
    expect((await r.resolve("some alpha thing")).model).toBe("flash");
    expect((await r.resolve("please do bravo")).model).toBe("midcoder");
    expect((await r.resolve("charlie matter")).model).toBe("opus");
  });

  it("falls back to the default route when nothing matches", async () => {
    const d = await newRouter().resolve("zzz nothing relevant");
    expect(d.source).toBe("fallback");
    expect(d.model).toBe("flash"); // DEFAULT_ROUTE = general
  });

  it("falls back to the default route on a near-tie (margin gate)", async () => {
    const r = newRouter();
    // A query hitting two routes' examples equally → top1≈top2 (margin ~0) →
    // don't escalate on a coin-flip; fall back to the cheap default.
    const d = await r.resolve("alpha bravo together"); // matches general + coding equally
    expect(d.source).toBe("fallback");
    expect(d.model).toBe("flash"); // DEFAULT_ROUTE = general
  });

  it("ratchets up and never downgrades within a conversation", async () => {
    const r = newRouter();
    // floor from an earlier heavy turn (rank 2): a coding turn must stay opus.
    const d = await r.resolve("now some bravo coding", 2);
    expect(d.model).toBe("opus");
    expect(d.source).toBe("ratchet");
  });

  it("does not let the ratchet floor block an upgrade", async () => {
    const r = newRouter();
    // floor coding (rank 1), but the turn is heavy (rank 2) → climbs to opus.
    const d = await r.resolve("charlie please", 1);
    expect(d.model).toBe("opus");
  });

  it("clamps to a vision-capable model when the turn has images", async () => {
    const r = newRouter();
    // bravo → coding (no vision); with images it must escalate to a
    // vision-capable route (heavy/opus).
    const d = await r.resolve("read the code in this bravo screenshot", -1, true);
    expect(d.model).toBe("opus");
    expect(d.source).toBe("vision");
  });

  it("reports the semantic intent route for stats even after a clamp", async () => {
    const r = newRouter();
    const d = await r.resolve("bravo coding task", 2); // ratcheted to opus
    expect(d.route).toBe("coding"); // intent preserved for stats
    expect(d.model).toBe("opus"); // model bumped
  });
});
