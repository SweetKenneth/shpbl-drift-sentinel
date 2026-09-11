// Signed, versioned, immutable baselines and explicit calibration. SPEC §3.2, §3.5, §3.6,
// invariants 2–3, states in §6.
import { createHmac } from "node:crypto";
import { Json, SentinelError, digestOf, requireId } from "./canonical.js";
import { Profile } from "./profile.js";

export interface Thresholds {
  low: number;
  medium: number;
  high: number;
  minSampleSize: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { low: 0.05, medium: 0.15, high: 0.35, minSampleSize: 30 };

export interface BaselineBody {
  agentId: string;
  name: string;
  version: number;
  profile: Profile;
  thresholds: Thresholds;
  createdAt: string;
}

export interface SignedBaseline {
  body: BaselineBody;
  keyRef: string;
  signature: string;
}

function sign(body: BaselineBody, keyRef: string, secret: string): string {
  return createHmac("sha256", secret).update(digestOf(body as unknown as Json)).digest("hex");
}

export function verifyBaseline(baseline: SignedBaseline, secret: string): boolean {
  const expected = sign(baseline.body, baseline.keyRef, secret);
  return expected === baseline.signature && expected.length === baseline.signature.length;
}

/** Append-only per (agentId, name) version store. Never mutates a stored version in place. */
export class BaselineStore {
  private readonly versions = new Map<string, SignedBaseline[]>();

  private key(agentId: string, name: string): string {
    return `${agentId}\u0000${name}`;
  }

  add(agentId: string, name: string, profile: Profile, thresholds: Thresholds, keyRef: string, secret: string, createdAt: string): SignedBaseline {
    const k = this.key(agentId, name);
    const list = this.versions.get(k) ?? [];
    const version = list.length + 1;
    const body: BaselineBody = { agentId, name, version, profile, thresholds, createdAt };
    const signature = sign(body, keyRef, secret);
    const record: SignedBaseline = { body, keyRef, signature };
    list.push(record);
    this.versions.set(k, list);
    return record;
  }

  latest(agentId: string, name: string): SignedBaseline | undefined {
    const list = this.versions.get(this.key(agentId, name));
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }

  get(agentId: string, name: string, version: number): SignedBaseline | undefined {
    return this.versions.get(this.key(agentId, name))?.find((b) => b.body.version === version);
  }

  /**
   * Test-only escape hatch returning the live stored record (not a clone), so conformance
   * tests can simulate on-disk tampering and confirm signature verification catches it.
   * Production code paths never use this — every normal read goes through `latest`/`get`.
   */
  debugGetMutableRecord(agentId: string, name: string, version: number): SignedBaseline | undefined {
    return this.get(agentId, name, version);
  }
}

export interface CalibrationProfile {
  calibrationProfileRef: string;
  agentId: string;
  thresholds: Thresholds;
  basis: { trueCount: number; falseCount: number };
}

/**
 * Derive a proposed threshold profile from labelled findings. Never mutates a baseline;
 * returns a reference the caller must explicitly apply (SPEC §3.5, §3.6).
 */
export function computeCalibration(
  agentId: string,
  base: Thresholds,
  labelled: Array<{ findingId: string; label: "true" | "false"; totalMagnitude: number }>,
): CalibrationProfile {
  const byId = new Map<string, "true" | "false">();
  const conflicts: string[] = [];
  for (const l of labelled) {
    const prior = byId.get(l.findingId);
    if (prior && prior !== l.label) conflicts.push(l.findingId);
    byId.set(l.findingId, l.label);
  }
  if (conflicts.length > 0) {
    throw new SentinelError("E_CALIBRATION", "contradictory labels for findings", "/labelledFindings", conflicts);
  }
  const falseMax = labelled.filter((l) => l.label === "false").reduce((m, l) => Math.max(m, l.totalMagnitude), 0);
  const trueMin = labelled
    .filter((l) => l.label === "true")
    .reduce((m, l) => Math.min(m, l.totalMagnitude), Number.POSITIVE_INFINITY);
  let low = base.low;
  if (falseMax > 0 && Number.isFinite(trueMin) && falseMax < trueMin) {
    low = (falseMax + trueMin) / 2;
  } else if (falseMax > 0) {
    low = Math.max(base.low, falseMax + 1e-6);
  }
  const thresholds: Thresholds = {
    low,
    medium: Math.max(base.medium, low + 0.01),
    high: Math.max(base.high, low + 0.02),
    minSampleSize: base.minSampleSize,
  };
  const trueCount = labelled.filter((l) => l.label === "true").length;
  const falseCount = labelled.filter((l) => l.label === "false").length;
  const calibrationProfileRef = digestOf({ agentId, thresholds, trueCount, falseCount } as unknown as Json);
  return { calibrationProfileRef, agentId, thresholds, basis: { trueCount, falseCount } };
}
