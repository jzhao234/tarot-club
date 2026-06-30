// Arcana routing eval / corpus regression check.
//
// Two modes:
//   npm run eval                 → run the labeled PROBES below through the REAL
//                                  embedder; print per-item pass/fail + accuracy;
//                                  exit non-zero if accuracy drops below the gate.
//   npm run eval -- <file>       → REPLAY mode: read newline-delimited queries
//                                  from <file> (e.g. real chat messages dumped
//                                  from Postgres), classify each, and report the
//                                  route distribution + low-confidence / near-tie
//                                  counts. This is the loop for tuning the corpus
//                                  on real traffic (see README "chat logs").
import { readFileSync } from "node:fs";
import { ArcanaRouter } from "../src/router";
import { TransformersEmbedder } from "../src/embedder";
import { MIN_CONFIDENCE, type RouteId } from "../src/routes";

const NEAR_TIE = 0.05; // top1−top2 below this is an ambiguous near-tie
const ACCURACY_GATE = 0.85; // labeled-mode CI gate

// Labeled probes — deliberately include paraphrases with NO keyword overlap and
// the canonical coding intents the audit flagged (tests/CI/docker/git/review).
const PROBES: { q: string; want: RouteId }[] = [
  // general
  { q: "can you summarize these meeting notes", want: "general" },
  { q: "tidy up the formatting on this list", want: "general" },
  { q: "give me the gist of this document", want: "general" },
  { q: "add up these numbers for me", want: "general" },
  { q: "what's the difference between these two terms", want: "general" },
  { q: "translate this paragraph to spanish", want: "general" },
  { q: "rewrite this sentence more clearly", want: "general" },
  { q: "what would be a good subject line for this email", want: "general" },
  // coding
  { q: "write a pandas script to clean this csv", want: "coding" },
  { q: "write a python function to dedupe a list", want: "coding" },
  { q: "my script keeps blowing up halfway through", want: "coding" },
  { q: "refactor this", want: "coding" },
  { q: "write a unit test for this function", want: "coding" },
  { q: "the deploy is failing", want: "coding" },
  { q: "write a dockerfile for this service", want: "coding" },
  { q: "how do i fix this git merge conflict", want: "coding" },
  { q: "review my pull request", want: "coding" },
  { q: "the ci pipeline is broken", want: "coding" },
  { q: "center a div with flexbox", want: "coding" },
  { q: "why is this returning undefined", want: "coding" },
  { q: "optimize this slow sql query", want: "coding" },
  // heavy
  { q: "draft a careful email to an important client about a delay", want: "heavy" },
  { q: "put together a pitch deck narrative for a launch", want: "heavy" },
  { q: "write a proposal for a prospective customer", want: "heavy" },
  { q: "help me reply tactfully to an angry customer", want: "heavy" },
  { q: "design a scalable architecture for this", want: "heavy" },
  { q: "weigh the trade-offs of these approaches in depth", want: "heavy" },
  { q: "write a polished executive summary for the board", want: "heavy" },
  { q: "reason through this complex strategic question", want: "heavy" },
];

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "n/a";
}

async function main() {
  const file = process.argv[2];
  const router = new ArcanaRouter(new TransformersEmbedder());
  process.stdout.write("loading model + corpus… ");
  await router.init();
  console.log("ready\n");

  if (file) {
    // REPLAY mode — unlabeled real queries.
    const lines = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const dist: Record<string, number> = {};
    let belowConf = 0;
    let nearTies = 0;
    for (const q of lines) {
      const c = await router.classify(q);
      dist[c.route] = (dist[c.route] ?? 0) + 1;
      if (c.score < MIN_CONFIDENCE) belowConf++;
      if (c.margin < NEAR_TIE) nearTies++;
    }
    console.log(`replayed ${lines.length} queries from ${file}`);
    console.log("route distribution:", dist);
    console.log(`below MIN_CONFIDENCE (${MIN_CONFIDENCE}): ${belowConf} (${pct(belowConf, lines.length)})`);
    console.log(`near-ties (margin < ${NEAR_TIE}): ${nearTies} (${pct(nearTies, lines.length)})`);
    return;
  }

  // LABELED mode — accuracy + regression gate.
  let pass = 0;
  const fails: string[] = [];
  for (const p of PROBES) {
    const c = await router.classify(p.q);
    const ok = c.route === p.want && c.score >= MIN_CONFIDENCE;
    if (ok) pass++;
    else fails.push(`  ✗ want=${p.want} got=${c.route} score=${c.score.toFixed(2)} margin=${c.margin.toFixed(2)}  "${p.q}"`);
    const mark = ok ? "✓" : "✗";
    console.log(`${mark} ${p.want.padEnd(8)} score=${c.score.toFixed(2)} margin=${c.margin.toFixed(2)}  ${p.q}`);
  }
  const acc = pass / PROBES.length;
  console.log(`\naccuracy: ${pass}/${PROBES.length} (${pct(pass, PROBES.length)}), gate ${pct(ACCURACY_GATE * 100, 100)}`);
  if (fails.length) {
    console.log("failures:\n" + fails.join("\n"));
  }
  if (acc < ACCURACY_GATE) {
    console.error(`\nFAIL: accuracy ${pct(pass, PROBES.length)} below gate ${pct(ACCURACY_GATE * 100, 100)}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
