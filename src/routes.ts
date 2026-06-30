// Arcana's routes: each is a task category mapped to a model, plus a cluster of
// EXAMPLE PHRASES. At startup the example phrases are embedded; at request time
// the query is embedded and matched (cosine, top-3 pooled) to the nearest
// cluster. Routing is by *meaning*, not keywords, so paraphrases land right.
//
// Tune by editing the example phrases below to match how your users actually
// phrase things, then re-run `npm run eval`. The defaults are reasonable
// starting points for a general-purpose assistant (everyday Q&A, coding, and
// higher-stakes / client-facing or complex work).

export type RouteId = "general" | "coding" | "heavy";

export interface RouteDef {
  id: RouteId;
  /** Pinned OpenRouter slug to route this category to. */
  model: string;
  /** Display name for logs / `/tiers` / the `/route` response (tarot-themed
   *  flavor — cosmetic only, never affects routing). The route `id` stays the
   *  functional name; this is the pretty label. */
  tier: string;
  /** Capability/cost order for the ratchet (higher = more capable). A
   *  conversation never drops below the highest rank it has used. */
  rank: number;
  /** Whether the model accepts image input (for the vision clamp). */
  vision: boolean;
  /** Example phrases that define this route (tune these — see top of file). */
  examples: string[];
}

/** The virtual model name apps point at; the real model is hidden behind it. */
export const ARCANA_MODEL = "arcana";

/** Low-confidence fallback: when no route clears MIN_CONFIDENCE (or the win is
 *  too narrow per MIN_MARGIN), use this — the cheapest tier handles generic /
 *  ambiguous input. */
export const DEFAULT_ROUTE: RouteId = "general";

/** Minimum top-3 cosine for the winning route to be trusted; below it we fall
 *  back to DEFAULT_ROUTE. Real intent matches typically score ~0.40-0.65. */
export const MIN_CONFIDENCE = 0.25;

/** Minimum top1−top2 score gap for the winner to be trusted. A near-tie means
 *  the embedder can't confidently separate two routes, so rather than escalate
 *  to a pricier tier on a coin-flip we fall back to DEFAULT_ROUTE. Conservative
 *  by default so it only catches genuine ties. */
export const MIN_MARGIN = 0.05;

// The default tier→model mapping uses public OpenRouter slugs. Swap these for
// whatever models you prefer; keep them PINNED (no `~`-floating aliases) so
// reasoning-signature reconstruction + prompt-cache pinning stay intact, and
// priced where you want each tier. Re-run `npm run eval` after any change.
export const ROUTES: RouteDef[] = [
  {
    id: "general",
    model: "google/gemini-3.5-flash",
    tier: "The Magician",
    rank: 0,
    vision: true,
    examples: [
      "what's the capital of france",
      "summarize this article for me",
      "explain how this works in simple terms",
      "give me a quick tldr of this document",
      "what does this acronym stand for",
      "rewrite this paragraph more clearly",
      "turn these notes into bullet points",
      "what's the difference between these two things",
      "add up these numbers for me",
      "reformat this list",
      "translate this sentence to spanish",
      "what time zone is this meeting in",
      "give me a one-line summary",
      "help me word this message",
      "make a checklist from these steps",
      "what are the key takeaways here",
      "define this term for me",
      "convert these figures into a table",
      "proofread this for typos",
      "what's a good subject line for this email",
    ],
  },
  {
    id: "coding",
    model: "z-ai/glm-5.2",
    tier: "The Hermit",
    rank: 1,
    vision: false,
    examples: [
      "write a python function to parse this csv",
      "fix this traceback in my script",
      "debug why this loop is slow",
      "build an html page with a contact form",
      "refactor this function",
      "write a unit test for this function",
      "add tests for this module",
      "what's the regex for an email address",
      "my script keeps crashing halfway through",
      "add a flexbox layout to this page",
      "write a sql query to join these tables",
      "why is this function returning undefined",
      "convert this code to use async await",
      "the build is failing with this error",
      "write a dockerfile for this app",
      "fix this github actions workflow",
      "how do i resolve this git merge conflict",
      "review this pull request for bugs",
      "optimize this database query",
      "add error handling to this code",
      "parse this json and extract the fields",
      "implement pagination for this api endpoint",
      "add type hints to this python code",
      "write css to center this div",
      "make this page responsive on mobile",
    ],
  },
  {
    id: "heavy",
    model: "anthropic/claude-opus-4.8",
    tier: "The Fool",
    rank: 2,
    vision: true,
    examples: [
      "draft a careful email to an important client",
      "write a proposal for a new customer",
      "design a scalable architecture for this system",
      "analyze the trade-offs of these two approaches in depth",
      "prove this result rigorously",
      "write a thorough competitive analysis",
      "walk through the long-term implications of this decision",
      "write a polished executive summary for the board",
      "help me respond diplomatically to an upset customer",
      "reason through this complex strategic question",
      "put together a detailed project plan with milestones",
      "negotiate this contract clause",
      "write a compelling, persuasive pitch",
      "evaluate the risks of this decision",
      "develop a go-to-market strategy",
      "think through the ethical considerations here",
      "build a financial model for this business case",
      "compose a delicate message to a key stakeholder",
      "write a rigorous technical design document",
      "craft a careful response to a sensitive situation",
    ],
  },
];
