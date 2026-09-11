// Deterministic seeded fixtures for the conformance suite. No external randomness source:
// mulberry32 PRNG seeded with a fixed integer, so every run is byte-reproducible.
import type { Trace } from "../src/profile.js";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenOpts {
  count: number;
  seed: number;
  startAt: string;
  toolWeights: Record<string, number>;
  escalationRate: number;
  refusalRate: number;
  minSteps?: number;
  maxSteps?: number;
  idPrefix?: string;
  extra?: (rng: () => number, traceIndex: number) => Record<string, unknown>;
}

function weightedPick(rng: () => number, weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = rng() * total;
  for (const [k, w] of entries) {
    x -= w;
    if (x <= 0) return k;
  }
  return entries[entries.length - 1]![0];
}

export function genTraces(opts: GenOpts): unknown[] {
  const rng = mulberry32(opts.seed);
  const minSteps = opts.minSteps ?? 3;
  const maxSteps = opts.maxSteps ?? 8;
  const base = Date.parse(opts.startAt);
  const traces: unknown[] = [];
  for (let i = 0; i < opts.count; i++) {
    const stepCount = minSteps + Math.floor(rng() * (maxSteps - minSteps + 1));
    const steps = [];
    for (let s = 0; s < stepCount; s++) {
      const tool = weightedPick(rng, opts.toolWeights);
      const escalation = rng() < opts.escalationRate;
      const outcome = rng() < opts.refusalRate ? "refused" : rng() < 0.05 ? "failure" : "success";
      steps.push({ tool, outcome, latencyMs: Math.round(50 + rng() * 900), ...(escalation ? { escalation: true } : {}) });
    }
    const startedAt = new Date(base + i * 60_000).toISOString();
    const extra = opts.extra ? opts.extra(rng, i) : {};
    traces.push({
      traceId: `${opts.idPrefix ?? "t"}-${String(i).padStart(4, "0")}`,
      startedAt,
      steps,
      tokens: { in: 1000 + Math.floor(rng() * 500), out: 100 + Math.floor(rng() * 300) },
      ...extra,
    });
  }
  return traces;
}

export const NORMAL_TOOL_WEIGHTS = { search: 61, "doc.write": 30, "shell.exec": 9 };
export const DRIFTED_TOOL_WEIGHTS = { search: 30, "doc.write": 36, "shell.exec": 34 };

export function normalTraces(count: number, seed = 1, startAt = "2026-09-01T00:00:00Z", idPrefix = "n"): unknown[] {
  return genTraces({ count, seed, startAt, toolWeights: NORMAL_TOOL_WEIGHTS, escalationRate: 0.004, refusalRate: 0.06, idPrefix });
}

export function driftedTraces(count: number, seed = 2, startAt = "2026-09-11T02:14:00Z", idPrefix = "d"): unknown[] {
  return genTraces({ count, seed, startAt, toolWeights: DRIFTED_TOOL_WEIGHTS, escalationRate: 0.071, refusalRate: 0.06, idPrefix });
}
