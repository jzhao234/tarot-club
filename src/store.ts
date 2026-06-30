// Store holds Arcana's mutable state: per-conversation pins (the ratchet floor)
// and aggregate usage stats ("what people use it for").
//
// Durability: when constructed with a `path`, the store loads its
// state from a JSON file at startup and persists changes back (debounced,
// atomic). This survives restarts, so a conversation that ratcheted up to a
// stronger model isn't silently downgraded after a redeploy. Without a `path`
// the store is pure in-memory (used by unit tests).
//
// Why a JSON file and not sqlite (the task's original wording): it needs zero
// dependencies and no native build (better-sqlite3 / node-gyp), which is the
// safe choice on this box, while giving the same durability + TTL eviction for
// this small state. The Store interface is unchanged, so swapping in sqlite
// later is a drop-in if queryable stats become useful.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Pin {
  rank: number;
  model: string;
  route: string;
  updatedAt: number;
}

export interface Stats {
  startedAt: number;
  totalRoutes: number;
  activeConversations: number;
  byRoute: Record<string, number>;
  byModel: Record<string, number>;
}

interface Snapshot {
  version: 1;
  startedAt: number;
  total: number;
  byRoute: Record<string, number>;
  byModel: Record<string, number>;
  pins: Record<string, Pin>;
}

export interface StoreOptions {
  /** File to persist state to. Omit for pure in-memory (no disk). */
  path?: string;
  /** Drop conversation pins idle longer than this. Default 14 days. */
  ttlMs?: number;
  /** Debounce window for async saves. Default 500ms. */
  saveDebounceMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class Store {
  private readonly pins = new Map<string, Pin>();
  private startedAt = Date.now();
  private total = 0;
  private readonly byRoute = new Map<string, number>();
  private readonly byModel = new Map<string, number>();

  private readonly path?: string;
  private readonly ttlMs: number;
  private readonly saveDebounceMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: StoreOptions = {}) {
    this.path = opts.path;
    this.ttlMs = opts.ttlMs ?? 14 * DAY_MS;
    this.saveDebounceMs = opts.saveDebounceMs ?? 500;
    if (this.path) this.load();
  }

  /** The conversation's current ratchet floor rank, or -1 if unseen. */
  floorRank(convId: string): number {
    if (!convId) return -1;
    return this.pins.get(convId)?.rank ?? -1;
  }

  /** Record a decision: ratchet the conversation pin upward (never down) and
   *  bump aggregate counters. A blank convId still counts toward stats. */
  commit(convId: string, d: { rank: number; model: string; route: string }): void {
    if (convId) {
      const cur = this.pins.get(convId);
      if (!cur || d.rank >= cur.rank) {
        this.pins.set(convId, { rank: d.rank, model: d.model, route: d.route, updatedAt: Date.now() });
      }
    }
    this.total += 1;
    this.byRoute.set(d.route, (this.byRoute.get(d.route) ?? 0) + 1);
    this.byModel.set(d.model, (this.byModel.get(d.model) ?? 0) + 1);
    this.scheduleSave();
  }

  stats(): Stats {
    return {
      startedAt: this.startedAt,
      totalRoutes: this.total,
      activeConversations: this.pins.size,
      byRoute: Object.fromEntries(this.byRoute),
      byModel: Object.fromEntries(this.byModel),
    };
  }

  /** Force a synchronous write and cancel any pending debounced save. Call on
   *  graceful shutdown so the last decisions aren't lost. No-op when in-memory. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  // ── persistence internals ──

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const snap = JSON.parse(readFileSync(this.path, "utf8")) as Snapshot;
      this.startedAt = snap.startedAt ?? this.startedAt;
      this.total = snap.total ?? 0;
      for (const [k, v] of Object.entries(snap.byRoute ?? {})) this.byRoute.set(k, v);
      for (const [k, v] of Object.entries(snap.byModel ?? {})) this.byModel.set(k, v);
      const cutoff = Date.now() - this.ttlMs;
      for (const [id, pin] of Object.entries(snap.pins ?? {})) {
        if (pin.updatedAt >= cutoff) this.pins.set(id, pin); // drop idle/expired pins
      }
    } catch (err) {
      // Corrupt/unreadable snapshot: start fresh rather than crash.
      console.error(`arcana store: could not load ${this.path}, starting fresh:`, err);
    }
  }

  private scheduleSave(): void {
    if (!this.path || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.saveDebounceMs);
    this.saveTimer.unref?.(); // don't keep the process alive for a pending save
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, pin] of this.pins) {
      if (pin.updatedAt < cutoff) this.pins.delete(id);
    }
  }

  private save(): void {
    if (!this.path) return;
    this.prune();
    const snap: Snapshot = {
      version: 1,
      startedAt: this.startedAt,
      total: this.total,
      byRoute: Object.fromEntries(this.byRoute),
      byModel: Object.fromEntries(this.byModel),
      pins: Object.fromEntries(this.pins),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(snap), "utf8");
      renameSync(tmp, this.path); // atomic replace
    } catch (err) {
      console.error(`arcana store: could not persist to ${this.path}:`, err);
    }
  }
}
