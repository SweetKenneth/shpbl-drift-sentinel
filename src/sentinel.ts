// Facade orchestrating ingest, baselines, drift checks, calibration and suppression.
import { Json, SentinelError, digestOf, requireId } from "./canonical.js";
import { Trace, TraceSet, buildProfile, detectOrderAnomaly, parseIngest, Profile } from "./profile.js";
import { BaselineStore, CalibrationProfile, DEFAULT_THRESHOLDS, SignedBaseline, Thresholds, computeCalibration, verifyBaseline } from "./baseline.js";
import { Confidence, Dimension, Severity, computeDimensions, confidenceFor, findingIdFor, novelFingerprints, pickExemplar, severityFor } from "./drift.js";
import { KnownChangeMarker, SuppressionConfig, evaluateSuppression, markerDigest, parseSuppressionConfig } from "./suppression.js";

export interface Finding {
  findingId: string;
  agentId: string;
  baselineName: string;
  severity: Severity;
  dimensions: Dimension[];
  novelFingerprints: string[];
  orderAnomaly: boolean;
  suppressed: boolean;
  matchedWindows: string[];
  matchedMarkers: string[];
  configurationVersion: number;
  exemplarTraceId: string;
  confidence: Confidence;
}

// Reference implementation's key resolution: `keyRef` is used directly as HMAC secret
// material. A production deployment would resolve `keyRef` through an external key
// manager; this package never contacts one (invariant 1 — no egress).
function resolveKey(keyRef: string): string {
  if (typeof keyRef !== "string" || keyRef.length === 0) {
    throw new SentinelError("E_INPUT", "expected keyRef", "/keyRef");
  }
  return keyRef;
}

export class DriftSentinel {
  private readonly traceSets = new Map<string, TraceSet>();
  private readonly profiles = new Map<string, { profile: Profile; traceSetRef: string; agentId: string }>();
  private readonly baselines = new BaselineStore();
  private readonly calibrations = new Map<string, CalibrationProfile>();
  private readonly findings = new Map<string, { finding: Finding; traceSetRef: string }>();
  private suppression: SuppressionConfig = { configurationVersion: 0, changedBy: "system", changedAt: new Date(0).toISOString(), maintenanceWindows: [], knownChangeMarkers: [] };

  ingestTraces(args: unknown): { agentId: string; traceSetRef: string; traceCount: number; orderAnomaly: boolean } {
    const { agentId, traces } = parseIngest(args);
    const orderAnomaly = detectOrderAnomaly(traces);
    const traceSetRef = digestOf({ agentId, traces } as unknown as Json);
    this.traceSets.set(traceSetRef, { traceSetRef, agentId, traces, orderAnomaly, ingestedAt: new Date().toISOString() });
    return { agentId, traceSetRef, traceCount: traces.length, orderAnomaly };
  }

  private loadTraceSet(traceSetRef: string): TraceSet {
    const ts = this.traceSets.get(traceSetRef);
    if (!ts) throw new SentinelError("E_NOT_FOUND", "unknown traceSetRef", "/traceSetRef");
    return ts;
  }

  private computeAndCacheProfile(ts: TraceSet): Profile {
    const profile = buildProfile(ts.agentId, ts.traces);
    this.profiles.set(profile.profileDigest, { profile, traceSetRef: ts.traceSetRef, agentId: ts.agentId });
    return profile;
  }

  setBaseline(args: unknown): { agentId: string; name: string; version: number; profileDigest: string; signature: string } {
    const r = args as Record<string, unknown>;
    const agentId = requireId(r?.agentId, "/agentId");
    const name = requireId(r?.name, "/name");
    const traceSetRef = requireId(r?.traceSetRef, "/traceSetRef");
    const keyRef = requireId(r?.keyRef, "/keyRef");
    const secret = resolveKey(keyRef);
    const ts = this.loadTraceSet(traceSetRef);
    const profile = this.computeAndCacheProfile(ts);
    const record = this.baselines.add(agentId, name, profile, DEFAULT_THRESHOLDS, keyRef, secret, new Date().toISOString());
    return { agentId, name, version: record.body.version, profileDigest: profile.profileDigest, signature: record.signature };
  }

  private loadTrustedBaseline(agentId: string, name: string, version: number | undefined, secret: string): SignedBaseline {
    const record = version === undefined ? this.baselines.latest(agentId, name) : this.baselines.get(agentId, name, version);
    if (!record) throw new SentinelError("E_NOT_FOUND", "baseline not found", "/baselineName");
    if (!verifyBaseline(record, secret)) {
      throw new SentinelError("E_BASELINE_UNTRUSTED", "signature verification failed", "/baselineName");
    }
    return record;
  }

  checkDrift(args: unknown): Finding | { clean: true; agentId: string; baselineName: string } {
    const r = args as Record<string, unknown>;
    const agentId = requireId(r?.agentId, "/agentId");
    const baselineName = requireId(r?.baselineName, "/baselineName");
    const traceSetRef = requireId(r?.traceSetRef, "/traceSetRef");
    const keyRef = requireId(r?.keyRef, "/keyRef");
    const secret = resolveKey(keyRef);
    const baseline = this.loadTrustedBaseline(agentId, baselineName, undefined, secret);
    const ts = this.loadTraceSet(traceSetRef);
    const candidate = this.computeAndCacheProfile(ts);

    const { dimensions, totalMagnitude } = computeDimensions(baseline.body.profile, candidate);
    if (dimensions.length === 0) return { clean: true, agentId, baselineName };

    const confidence = confidenceFor(candidate.traceCount, baseline.body.thresholds);
    const severity = severityFor(totalMagnitude, baseline.body.thresholds, confidence);
    const novel = novelFingerprints(baseline.body.profile, candidate);
    const exemplarTraceId = pickExemplar(baseline.body.profile, ts.traces);

    const markerFieldDigests: Record<string, string> = {};
    for (const trace of ts.traces) {
      for (const key of Object.keys(trace.extra)) {
        if (key.endsWith("Digest")) markerFieldDigests[key.replace(/Digest$/, "")] = trace.extra[key] as string;
      }
    }
    const suppression = evaluateSuppression(this.suppression, candidate.windowStart, candidate.windowEnd, markerFieldDigests);

    const findingId = findingIdFor(agentId, baselineName, baseline.body.version, traceSetRef);
    const finding: Finding = {
      findingId,
      agentId,
      baselineName,
      severity,
      dimensions,
      novelFingerprints: novel,
      orderAnomaly: ts.orderAnomaly,
      suppressed: suppression.suppressed,
      matchedWindows: suppression.matchedWindows,
      matchedMarkers: suppression.matchedMarkers,
      configurationVersion: suppression.configurationVersion,
      exemplarTraceId,
      confidence,
    };
    this.findings.set(findingId, { finding, traceSetRef });
    return finding;
  }

  explainDrift(args: unknown): { findingId: string; dimensions: Dimension[]; replay: Json } {
    const r = args as Record<string, unknown>;
    const findingId = requireId(r?.findingId, "/findingId");
    const entry = this.findings.get(findingId);
    if (!entry) throw new SentinelError("E_NOT_FOUND", "finding not found", "/findingId");
    const ts = this.loadTraceSet(entry.traceSetRef);
    const trace = ts.traces.find((t) => t.traceId === entry.finding.exemplarTraceId)!;
    const replay = {
      traceId: trace.traceId,
      startedAt: trace.startedAt,
      steps: trace.steps.map((s) => ({ tool: s.tool, outcome: s.outcome, latencyMs: s.latencyMs, escalation: !!s.escalation, ...s.extra })),
      ...trace.extra,
    } as unknown as Json;
    return { findingId, dimensions: entry.finding.dimensions, replay };
  }

  calibrate(args: unknown): CalibrationProfile {
    const r = args as Record<string, unknown>;
    const agentId = requireId(r?.agentId, "/agentId");
    const labelled = Array.isArray(r?.labelledFindings) ? (r!.labelledFindings as Array<{ findingId: string; label: "true" | "false" }>) : [];
    const enriched = labelled.map((l) => {
      const entry = this.findings.get(l.findingId);
      const totalMagnitude = entry ? entry.finding.dimensions.reduce((s, d) => s + d.contribution, 0) * 0 + entry.finding.dimensions.reduce((s, d) => s + d.contribution * 1, 0) : 0;
      // magnitude proxy: sum of raw dimension baseline/observed gap already folded into contribution*totalMagnitude is not retained;
      // use severity rank as an ordinal proxy so calibration remains a pure function of recorded findings.
      const rank = { info: 0, low: 1, medium: 2, high: 3 }[entry?.finding.severity ?? "info"];
      return { findingId: l.findingId, label: l.label, totalMagnitude: rank };
    });
    const profile = computeCalibration(agentId, DEFAULT_THRESHOLDS, enriched);
    this.registerCalibration(profile);
    return profile;
  }

  applyCalibration(args: unknown): { agentId: string; name: string; version: number; signature: string } {
    const r = args as Record<string, unknown>;
    const agentId = requireId(r?.agentId, "/agentId");
    const name = requireId(r?.baselineName, "/baselineName");
    const baselineVersion = Number(r?.baselineVersion);
    const calibrationProfileRef = requireId(r?.calibrationProfileRef, "/calibrationProfileRef");
    const keyRef = requireId(r?.keyRef, "/keyRef");
    const secret = resolveKey(keyRef);
    const prior = this.loadTrustedBaseline(agentId, name, baselineVersion, secret);
    const calibration = [...this.calibrations.values()].find((c) => c.calibrationProfileRef === calibrationProfileRef);
    if (!calibration) throw new SentinelError("E_NOT_FOUND", "calibration profile not found", "/calibrationProfileRef");
    const record = this.baselines.add(agentId, name, prior.body.profile, calibration.thresholds, keyRef, secret, new Date().toISOString());
    return { agentId, name, version: record.body.version, signature: record.signature };
  }

  configureSuppression(config: unknown): SuppressionConfig {
    this.suppression = parseSuppressionConfig(config, this.suppression.configurationVersion);
    return this.suppression;
  }

  registerCalibration(profile: CalibrationProfile): void {
    this.calibrations.set(profile.calibrationProfileRef, profile);
  }

  markerDigestOf(value: string): string {
    return markerDigest(value);
  }

  /** Test-only escape hatch: see BaselineStore.debugGetMutableRecord. */
  debugBaselines(): BaselineStore {
    return this.baselines;
  }
}
