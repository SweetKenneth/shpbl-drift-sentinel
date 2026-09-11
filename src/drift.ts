// Divergence measurement, severity assignment, exemplar selection. SPEC §4.2, §4.3,
// invariants 4, 5, 7.
import { Json, clamp01, digestOf, round } from "./canonical.js";
import { Profile, Trace, fingerprintOf } from "./profile.js";
import { Thresholds } from "./baseline.js";

export type Direction = "increase" | "decrease" | "no-change";
export type Severity = "info" | "low" | "medium" | "high";
export type Confidence = "insufficient-sample" | "sufficient-sample";

export interface Dimension {
  name: string;
  baseline: number;
  observed: number;
  direction: Direction;
  contribution: number;
}

const EPSILON = 1e-9;

function directionOf(base: number, observed: number): Direction {
  if (observed > base + EPSILON) return "increase";
  if (observed < base - EPSILON) return "decrease";
  return "no-change";
}

interface RawDim {
  name: string;
  baseline: number;
  observed: number;
  magnitude: number;
}

function collectRawDims(baseline: Profile, candidate: Profile): RawDim[] {
  const dims: RawDim[] = [];
  const push = (name: string, base: number, observed: number, magnitude: number) => {
    if (magnitude > EPSILON) dims.push({ name, baseline: base, observed, magnitude });
  };

  push("refusalRate", baseline.refusalRate, candidate.refusalRate, Math.abs(candidate.refusalRate - baseline.refusalRate));
  push(
    "escalationRate",
    baseline.escalationRate,
    candidate.escalationRate,
    Math.abs(candidate.escalationRate - baseline.escalationRate),
  );

  const tools = new Set([...Object.keys(baseline.toolMix), ...Object.keys(candidate.toolMix)]);
  for (const t of [...tools].sort()) {
    const b = baseline.toolMix[t] ?? 0;
    const o = candidate.toolMix[t] ?? 0;
    push(`toolMix.${t}`, b, o, Math.abs(o - b));
  }

  const outcomes = new Set([...Object.keys(baseline.outcomeMix), ...Object.keys(candidate.outcomeMix)]);
  for (const o of [...outcomes].sort()) {
    const b = baseline.outcomeMix[o] ?? 0;
    const v = candidate.outcomeMix[o] ?? 0;
    push(`outcomeMix.${o}`, b, v, Math.abs(v - b));
  }

  for (const q of ["p50", "p90", "p99"] as const) {
    const b = baseline.latencyMs[q];
    const o = candidate.latencyMs[q];
    push(`latencyMs.${q}`, b, o, Math.abs(o - b) / Math.max(b, 1));
    const bs = baseline.steps[q];
    const os = candidate.steps[q];
    push(`steps.${q}`, bs, os, Math.abs(os - bs) / Math.max(bs, 1));
  }

  return dims;
}

export function computeDimensions(baseline: Profile, candidate: Profile): { dimensions: Dimension[]; totalMagnitude: number } {
  const raw = collectRawDims(baseline, candidate);
  const totalMagnitude = raw.reduce((s, d) => s + d.magnitude, 0);
  const sorted = [...raw].sort((a, b) => b.magnitude - a.magnitude || a.name.localeCompare(b.name));
  const dimensions: Dimension[] = sorted.map((d) => ({
    name: d.name,
    baseline: d.baseline,
    observed: d.observed,
    direction: directionOf(d.baseline, d.observed),
    contribution: totalMagnitude > 0 ? d.magnitude / totalMagnitude : 0,
  }));
  return { dimensions, totalMagnitude };
}

export function severityFor(totalMagnitude: number, thresholds: Thresholds, confidence: Confidence): Severity {
  let severity: Severity;
  if (totalMagnitude < thresholds.low) severity = "info";
  else if (totalMagnitude < thresholds.medium) severity = "low";
  else if (totalMagnitude < thresholds.high) severity = "medium";
  else severity = "high";
  // Invariant 7 / P8: severity is never reported above `info` at insufficient sample size,
  // and is always present — never omitted.
  return confidence === "insufficient-sample" ? "info" : severity;
}

export function confidenceFor(traceCount: number, thresholds: Thresholds): Confidence {
  return traceCount < thresholds.minSampleSize ? "insufficient-sample" : "sufficient-sample";
}

export function novelFingerprints(baseline: Profile, candidate: Profile): string[] {
  const known = new Set(Object.keys(baseline.fingerprints.counts));
  return Object.keys(candidate.fingerprints.counts)
    .filter((d) => !known.has(d))
    .sort();
}

/** Pick the trace whose own tool-mix departs most from the baseline mix; ties broken by traceId. */
export function pickExemplar(baseline: Profile, traces: Trace[]): string {
  let best: { id: string; score: number } | null = null;
  for (const trace of traces) {
    const counts: Record<string, number> = {};
    for (const s of trace.steps) counts[s.tool] = (counts[s.tool] ?? 0) + 1;
    let score = 0;
    const tools = new Set([...Object.keys(counts), ...Object.keys(baseline.toolMix)]);
    for (const t of tools) {
      const observed = (counts[t] ?? 0) / trace.steps.length;
      const base = baseline.toolMix[t] ?? 0;
      score += Math.abs(observed - base);
    }
    if (!best || score > best.score || (score === best.score && trace.traceId < best.id)) {
      best = { id: trace.traceId, score };
    }
  }
  return best ? best.id : traces[0]!.traceId;
}

export function findingIdFor(agentId: string, baselineName: string, baselineVersion: number, traceSetRef: string): string {
  return digestOf({ agentId, baselineName, baselineVersion, traceSetRef } as unknown as Json).slice(0, 16);
}
