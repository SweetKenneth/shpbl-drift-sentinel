// Trace validation, ingest normalization, and behaviour-profile computation. SPEC §2, §3.1, §4.1.
import {
  Json,
  MAX_STEPS_PER_TRACE,
  MAX_TRACES_PER_CALL,
  SentinelError,
  TOOL_NAME_RE,
  clamp01,
  digestOf,
  quantile,
  requireId,
  requireTimestamp,
  round,
  sha256,
} from "./canonical.js";
import { redactExtra } from "./redaction.js";

export type Outcome = "success" | "failure" | "refused";

export interface Step {
  tool: string;
  outcome: Outcome;
  latencyMs: number;
  escalation?: boolean;
  extra: Record<string, Json>;
}

export interface Trace {
  traceId: string;
  startedAt: string;
  steps: Step[];
  tokensIn: number;
  tokensOut: number;
  extra: Record<string, Json>;
}

export interface TraceSet {
  traceSetRef: string;
  agentId: string;
  traces: Trace[];
  orderAnomaly: boolean;
  ingestedAt: string;
}

const STEP_FIXED_KEYS = new Set(["tool", "outcome", "latencyMs", "escalation"]);
const TRACE_FIXED_KEYS = new Set(["traceId", "startedAt", "steps", "tokens"]);
const OUTCOMES: Outcome[] = ["success", "failure", "refused"];

function parseStep(raw: unknown, pointer: string): Step {
  if (typeof raw !== "object" || raw === null) {
    throw new SentinelError("E_INPUT", "expected step object", pointer);
  }
  const r = raw as Record<string, unknown>;
  const tool = r.tool;
  if (typeof tool !== "string" || !TOOL_NAME_RE.test(tool)) {
    throw new SentinelError("E_INPUT", "expected tool name matching pattern", `${pointer}/tool`);
  }
  const outcome = r.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as Outcome)) {
    throw new SentinelError("E_INPUT", "expected outcome enum", `${pointer}/outcome`);
  }
  const latencyMs = r.latencyMs;
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new SentinelError("E_INPUT", "expected non-negative latencyMs", `${pointer}/latencyMs`);
  }
  const escalation = r.escalation === undefined ? undefined : Boolean(r.escalation);
  const extra = redactExtra(r, STEP_FIXED_KEYS);
  return { tool, outcome: outcome as Outcome, latencyMs, escalation, extra };
}

function parseTrace(raw: unknown, pointer: string): Trace {
  if (typeof raw !== "object" || raw === null) {
    throw new SentinelError("E_INPUT", "expected trace object", pointer);
  }
  const r = raw as Record<string, unknown>;
  const traceId = requireId(r.traceId, `${pointer}/traceId`);
  const startedAt = requireTimestamp(r.startedAt, `${pointer}/startedAt`);
  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    throw new SentinelError("E_INPUT", "expected non-empty steps array", `${pointer}/steps`);
  }
  if (r.steps.length > MAX_STEPS_PER_TRACE) {
    throw new SentinelError("E_INPUT", "too many steps", `${pointer}/steps`);
  }
  const steps = r.steps.map((s, i) => parseStep(s, `${pointer}/steps/${i}`));
  const tokens = r.tokens as { in?: unknown; out?: unknown } | undefined;
  const tokensIn = typeof tokens?.in === "number" ? tokens.in : 0;
  const tokensOut = typeof tokens?.out === "number" ? tokens.out : 0;
  const extra = redactExtra(r, TRACE_FIXED_KEYS);
  return { traceId, startedAt, steps, tokensIn, tokensOut, extra };
}

/** Validate and normalize an ingest_traces call. Whole call is rejected on any error (SPEC §7). */
export function parseIngest(args: unknown): { agentId: string; traces: Trace[] } {
  if (typeof args !== "object" || args === null) {
    throw new SentinelError("E_INPUT", "expected object", "");
  }
  const r = args as Record<string, unknown>;
  const agentId = requireId(r.agentId, "/agentId");
  if (!Array.isArray(r.traces) || r.traces.length === 0) {
    throw new SentinelError("E_INPUT", "expected non-empty traces array", "/traces");
  }
  if (r.traces.length > MAX_TRACES_PER_CALL) {
    throw new SentinelError("E_INPUT", "too many traces", "/traces");
  }
  const traces = r.traces.map((t, i) => parseTrace(t, `/traces/${i}`));
  return { agentId, traces };
}

export function detectOrderAnomaly(traces: Trace[]): boolean {
  for (let i = 1; i < traces.length; i++) {
    if (Date.parse(traces[i]!.startedAt) < Date.parse(traces[i - 1]!.startedAt)) return true;
  }
  return false;
}

export function fingerprintOf(trace: Trace): string {
  return sha256(JSON.stringify(trace.steps.map((s) => s.tool)));
}

export interface Profile {
  agentId: string;
  traceCount: number;
  windowStart: string;
  windowEnd: string;
  toolMix: Record<string, number>;
  outcomeMix: Record<string, number>;
  refusalRate: number;
  latencyMs: { p50: number; p90: number; p99: number };
  steps: { p50: number; p90: number; p99: number };
  escalationRate: number;
  fingerprints: { distinct: number; counts: Record<string, number>; top: Array<{ digest: string; share: number }> };
  profileDigest: string;
}

export function buildProfile(agentId: string, traces: Trace[]): Profile {
  const toolCounts: Record<string, number> = {};
  const outcomeCounts: Record<string, number> = {};
  const latencies: number[] = [];
  const stepCounts: number[] = [];
  const fpCounts: Record<string, number> = {};
  let totalSteps = 0;
  let escalations = 0;
  let refusals = 0;

  const sortedTimes = traces.map((t) => t.startedAt).sort();
  for (const trace of traces) {
    stepCounts.push(trace.steps.length);
    for (const step of trace.steps) {
      totalSteps++;
      toolCounts[step.tool] = (toolCounts[step.tool] ?? 0) + 1;
      outcomeCounts[step.outcome] = (outcomeCounts[step.outcome] ?? 0) + 1;
      latencies.push(step.latencyMs);
      if (step.outcome === "refused") refusals++;
      if (step.escalation) escalations++;
    }
    const fp = fingerprintOf(trace);
    fpCounts[fp] = (fpCounts[fp] ?? 0) + 1;
  }
  latencies.sort((a, b) => a - b);
  stepCounts.sort((a, b) => a - b);

  const toolMix: Record<string, number> = {};
  for (const k of Object.keys(toolCounts).sort()) toolMix[k] = round(toolCounts[k]! / totalSteps);
  const outcomeMix: Record<string, number> = {};
  for (const k of Object.keys(outcomeCounts).sort()) outcomeMix[k] = round(outcomeCounts[k]! / totalSteps);

  const topFingerprints = Object.entries(fpCounts)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([digest, count]) => ({ digest, share: round(count / traces.length) }));

  const profile: Omit<Profile, "profileDigest"> = {
    agentId,
    traceCount: traces.length,
    windowStart: sortedTimes[0]!,
    windowEnd: sortedTimes[sortedTimes.length - 1]!,
    toolMix,
    outcomeMix,
    refusalRate: round(clamp01(refusals / totalSteps)),
    latencyMs: { p50: round(quantile(latencies, 0.5)), p90: round(quantile(latencies, 0.9)), p99: round(quantile(latencies, 0.99)) },
    steps: { p50: round(quantile(stepCounts, 0.5)), p90: round(quantile(stepCounts, 0.9)), p99: round(quantile(stepCounts, 0.99)) },
    escalationRate: round(clamp01(escalations / totalSteps)),
    fingerprints: { distinct: Object.keys(fpCounts).length, counts: fpCounts, top: topFingerprints },
  };
  const profileDigest = digestOf(profile as unknown as Json);
  return { ...profile, profileDigest };
}
