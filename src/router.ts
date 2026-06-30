import type { Embedder } from "./embedder";
import {
  ROUTES,
  DEFAULT_ROUTE,
  MIN_CONFIDENCE,
  MIN_MARGIN,
  type RouteDef,
  type RouteId,
} from "./routes";

export interface Decision {
  /** Semantic intent the query matched (for stats / "what people use it for"). */
  route: RouteId;
  /** The real model to actually use (after the ratchet + vision clamp). Callers
   *  typically keep this server-side and surface only the virtual "arcana". */
  model: string;
  /** Themed display name of the chosen route/tier (e.g. "The Hermit"). For
   *  logs/stats only. */
  tier: string;
  /** Effective capability rank used (the conversation floor). */
  rank: number;
  /** Top-3 cosine of the matched route (confidence). */
  score: number;
  /** top1 − top2 score gap. Small margins mean a near-tie the embedder isn't
   *  confident about. Logged for calibration; not yet acted on. */
  margin: number;
  /** Per-route scores, for logging/tuning. */
  scores: Record<string, number>;
  /** How the model was chosen. */
  source: "semantic" | "fallback" | "ratchet" | "vision";
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// top-3 mean pooling: a route's score is the mean of
// its three closest example phrases, so one stray example can't hijack a route.
function top3mean(sims: number[]): number {
  const s = [...sims].sort((a, b) => b - a).slice(0, 3);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
}

export class ArcanaRouter {
  private readonly byId = new Map<RouteId, RouteDef>();
  private readonly byRankAsc: RouteDef[]; // routes sorted by ascending rank
  private readonly vectors = new Map<RouteId, number[][]>();
  private ready: Promise<void> | null = null;

  constructor(
    private readonly embedder: Embedder,
    private readonly routes: RouteDef[] = ROUTES,
  ) {
    for (const r of routes) this.byId.set(r.id, r);
    this.byRankAsc = [...routes].sort((a, b) => a.rank - b.rank);
  }

  /** Embed every route's example cluster once. Idempotent. */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        for (const r of this.routes) {
          this.vectors.set(r.id, await Promise.all(r.examples.map((e) => this.embedder.embed(e))));
        }
      })();
    }
    return this.ready;
  }

  /** classify scores the query against each route (no ratchet, no vision clamp). */
  async classify(
    query: string,
  ): Promise<{ route: RouteId; score: number; margin: number; scores: Record<string, number> }> {
    await this.init();
    const q = await this.embedder.embed(query);
    const scores: Record<string, number> = {};
    for (const r of this.routes) {
      scores[r.id] = top3mean((this.vectors.get(r.id) ?? []).map((v) => dot(q, v)));
    }
    const ranked = (Object.entries(scores) as [RouteId, number][]).sort((a, b) => b[1] - a[1]);
    const [topId, topScore] = ranked[0] ?? [DEFAULT_ROUTE, 0];
    const margin = topScore - (ranked[1]?.[1] ?? 0);
    return { route: topId, score: topScore, margin, scores };
  }

  /**
   * resolve picks the model for a turn:
   *   1. classify by meaning → intent route
   *   2. low confidence → DEFAULT_ROUTE
   *   3. RATCHET: never drop below the conversation's floor rank (so a convo
   *      that already needed a stronger model keeps it)
   *   4. VISION clamp: if the turn has images and the chosen model can't see
   *      them, escalate to the highest-rank vision-capable route
   */
  async resolve(query: string, floorRank = -1, hasImages = false): Promise<Decision> {
    const c = await this.classify(query);

    let route = c.route;
    let source: Decision["source"] = "semantic";
    // Fall back to the cheap default when the winner is weak (below the
    // confidence floor) OR a near-tie (margin too small to trust). The latter
    // avoids escalating to a pricier tier on an embedder coin-flip.
    if (c.score < MIN_CONFIDENCE || c.margin < MIN_MARGIN) {
      route = DEFAULT_ROUTE;
      source = "fallback";
    }

    // Ratchet: use the more capable of (intent rank, conversation floor rank).
    // Rank-gap-robust: pick the lowest route whose rank is ≥ the floor.
    let chosen = this.byId.get(route)!;
    if (floorRank > chosen.rank) {
      chosen = this.routeAtOrAboveRank(floorRank);
      source = "ratchet";
    }

    // Vision clamp: the chosen model must be able to see attached images.
    if (hasImages && !chosen.vision) {
      const visionRoute = this.lowestVisionRouteAtOrAbove(chosen.rank);
      if (visionRoute) {
        chosen = visionRoute;
        source = "vision";
      }
    }

    return {
      route: c.route, // report the semantic intent for stats, even after a clamp
      model: chosen.model,
      tier: chosen.tier,
      rank: chosen.rank,
      score: c.score,
      margin: c.margin,
      scores: c.scores,
      source,
    };
  }

  /** Lowest-ranked route whose rank is ≥ the given floor; clamps to the most
   *  capable route if the floor exceeds every rank. */
  private routeAtOrAboveRank(rank: number): RouteDef {
    for (const r of this.byRankAsc) {
      if (r.rank >= rank) return r;
    }
    return this.byRankAsc[this.byRankAsc.length - 1];
  }

  /** Cheapest vision-capable route at or above a rank floor (so the vision
   *  clamp doesn't needlessly jump to the most expensive model). Falls back to
   *  any vision route if none clears the floor. */
  private lowestVisionRouteAtOrAbove(rank: number): RouteDef | null {
    let atOrAbove: RouteDef | null = null;
    let anyVision: RouteDef | null = null;
    for (const r of this.byRankAsc) {
      if (!r.vision) continue;
      if (!anyVision) anyVision = r;
      if (r.rank >= rank && !atOrAbove) atOrAbove = r;
    }
    return atOrAbove ?? anyVision;
  }

  routes_(): RouteDef[] {
    return this.routes;
  }
}
