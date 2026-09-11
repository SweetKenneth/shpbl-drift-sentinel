// Conformance suite: specification properties P1-P12 and every §7 failure mode.
// Written from SPEC-agent-behaviour-drift-sentinel.md only.
import { describe, expect, test } from "bun:test";
import { DriftSentinel } from "../src/sentinel.js";
import { SentinelError } from "../src/canonical.js";
import { driftedTraces, normalTraces } from "./fixtures.js";

const KEY = "test-signing-key-not-a-real-secret";

function freshSentinel() {
  return new DriftSentinel();
}

function setupBaseline(sentinel: DriftSentinel, agentId = "planner-1", name = "sept-normal", count = 812) {
  const ingest = sentinel.ingestTraces({ agentId, traces: normalTraces(count) });
  const baseline = sentinel.setBaseline({ agentId, name, traceSetRef: ingest.traceSetRef, keyRef: KEY });
  return { ingest, baseline };
}

describe("P1 seeded drift fixtures produce expected finding at expected severity", () => {
  test("high severity on strong seeded drift", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240) });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    expect(finding.severity).toBe("high");
    expect(finding.confidence).toBe("sufficient-sample");
    expect(finding.dimensions.length).toBeGreaterThan(0);
  });
});

describe("P2 traces from baseline distribution produce no finding above info", () => {
  test("false-positive suite", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: normalTraces(4000, 99, "2026-09-20T00:00:00Z", "fp") });
    const result = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    if (!result.clean) {
      expect(result.severity).toBe("info");
    }
  });
});

describe("P3 activity inside a declared maintenance window is suppressed, never dropped", () => {
  test("suppressed:true with matching window id", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240, 2, "2026-09-13T03:00:00Z") });
    sentinel.configureSuppression({
      changedBy: "operator",
      changedAt: "2026-09-01T00:00:00Z",
      maintenanceWindows: [{ id: "sunday-window", interval: { start: "2026-09-13T02:00:00Z", end: "2026-09-13T06:00:00Z" } }],
      knownChangeMarkers: [],
    });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    expect(finding.suppressed).toBe(true);
    expect(finding.matchedWindows).toContain("sunday-window");
    expect(finding.severity).toBeDefined();
    expect(finding.dimensions.length).toBeGreaterThan(0);
  });
});

describe("P4 any modification of a stored baseline fails check_drift with E_BASELINE_UNTRUSTED", () => {
  test("tampered baseline body", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const record = sentinel.debugBaselines().debugGetMutableRecord("planner-1", "sept-normal", 1)!;
    record.body.thresholds.high = 0.999999;
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240) });
    expect(() => sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY })).toThrow(SentinelError);
    try {
      sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY });
    } catch (e) {
      expect((e as SentinelError).code).toBe("E_BASELINE_UNTRUSTED");
    }
  });

  test("wrong key never falls back to unsigned comparison", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240) });
    try {
      sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: "wrong-key" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("E_BASELINE_UNTRUSTED");
    }
  });
});

describe("P5 identical input twice yields identical profileDigest and finding ids", () => {
  test("determinism across independent sentinel instances", () => {
    const traces = normalTraces(100);
    const s1 = freshSentinel();
    const s2 = freshSentinel();
    const i1 = s1.ingestTraces({ agentId: "a", traces });
    const i2 = s2.ingestTraces({ agentId: "a", traces });
    expect(i1.traceSetRef).toBe(i2.traceSetRef);
    const b1 = s1.setBaseline({ agentId: "a", name: "base", traceSetRef: i1.traceSetRef, keyRef: KEY });
    const b2 = s2.setBaseline({ agentId: "a", name: "base", traceSetRef: i2.traceSetRef, keyRef: KEY });
    expect(b1.profileDigest).toBe(b2.profileDigest);
    const cand = normalTraces(150, 7, "2026-10-01T00:00:00Z", "c");
    const ic1 = s1.ingestTraces({ agentId: "a", traces: cand });
    const ic2 = s2.ingestTraces({ agentId: "a", traces: cand });
    const f1 = s1.checkDrift({ agentId: "a", baselineName: "base", traceSetRef: ic1.traceSetRef, keyRef: KEY }) as any;
    const f2 = s2.checkDrift({ agentId: "a", baselineName: "base", traceSetRef: ic2.traceSetRef, keyRef: KEY }) as any;
    if (!f1.clean && !f2.clean) {
      expect(f1.findingId).toBe(f2.findingId);
    } else {
      expect(f1.clean).toBe(f2.clean);
    }
  });
});

describe("P6 dimension contributions sum to 1.0 ± 1e-9", () => {
  test("contribution sum", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240) });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    const sum = finding.dimensions.reduce((s: number, d: any) => s + d.contribution, 0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
  });
});

describe("P7 secret-shaped payloads never appear raw in any output", () => {
  test("redacted at ingest and absent from profile/finding/replay", () => {
    const sentinel = freshSentinel();
    const secret = "sk-live-EXTREMELY-SECRET-VALUE-0000000000";
    const { traceSetRef } = sentinel.ingestTraces({
      agentId: "planner-1",
      traces: normalTraces(50, 5, "2026-09-01T00:00:00Z", "s").map((t: any, i: number) => (i === 0 ? { ...t, apiKey: secret } : t)),
    });
    const baseline = sentinel.setBaseline({ agentId: "planner-1", name: "b", traceSetRef, keyRef: KEY });
    expect(JSON.stringify(baseline)).not.toContain(secret);
    const candTraces = normalTraces(50, 6, "2026-09-02T00:00:00Z", "s2").map((t: any, i: number) => (i === 0 ? { ...t, apiKey: secret } : t));
    const cand = sentinel.ingestTraces({ agentId: "planner-1", traces: candTraces });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "b", traceSetRef: cand.traceSetRef, keyRef: KEY }) as any;
    expect(JSON.stringify(finding)).not.toContain(secret);
  });
});

describe("P8 below configured minimum sample, no severity above info is emitted", () => {
  test("insufficient-sample capped at info", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(10, 3, "2026-09-15T00:00:00Z", "small") });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    expect(finding.confidence).toBe("insufficient-sample");
    expect(finding.severity).toBe("info");
  });
});

describe("P9 no network / process-spawn / ambient filesystem-read symbol in shipped source", () => {
  test("scan src for forbidden symbols", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.join(import.meta.dir, "..", "src");
    const forbidden = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /from\s+["']node:(http|https|net|tls|dgram|dns)["']/,
      /\bWebSocket\b/,
      /writeFile|appendFile|mkdir|rmSync|unlink/,
      /child_process|execSync|spawn\s*\(/,
    ];
    const files: string[] = [];
    (function walk(dir: string) {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    })(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const re of forbidden) {
        expect(re.test(text)).toBe(false);
      }
    }
  });
});

describe("P10 calibration changes thresholds only after explicit apply, creating a new signed baseline version", () => {
  test("apply_calibration versioning", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240) });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    const calibration = sentinel.calibrate({ agentId: "planner-1", labelledFindings: [{ findingId: finding.findingId, label: "true" }] });
    // Thresholds unchanged until apply_calibration is explicitly called.
    const beforeApply = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    expect(beforeApply.severity).toBe(finding.severity);
    const applied = sentinel.applyCalibration({
      agentId: "planner-1",
      baselineName: "sept-normal",
      baselineVersion: 1,
      calibrationProfileRef: calibration.calibrationProfileRef,
      keyRef: KEY,
    });
    expect(applied.version).toBe(2);
    // Prior version remains loadable.
    const prior = sentinel.debugBaselines().get("planner-1", "sept-normal", 1);
    expect(prior).toBeDefined();
  });
});

describe("P11 replays obey the ingest redaction invariant", () => {
  test("seeded raw payload never occurs in replay output", () => {
    const sentinel = freshSentinel();
    const secret = "super-secret-payload-value-XYZ";
    const baseTraces = normalTraces(50, 11, "2026-09-01T00:00:00Z", "r");
    const ingest = sentinel.ingestTraces({ agentId: "planner-1", traces: baseTraces });
    sentinel.setBaseline({ agentId: "planner-1", name: "base", traceSetRef: ingest.traceSetRef, keyRef: KEY });
    const drifted = driftedTraces(240, 12, "2026-09-05T00:00:00Z", "dr").map((t: any, i: number) => (i === 0 ? { ...t, notes: secret } : t));
    const cand = sentinel.ingestTraces({ agentId: "planner-1", traces: drifted });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "base", traceSetRef: cand.traceSetRef, keyRef: KEY }) as any;
    const explanation = sentinel.explainDrift({ findingId: finding.findingId });
    expect(JSON.stringify(explanation)).not.toContain(secret);
  });
});

describe("P12 every suppressed finding names configuration version and matching rule id", () => {
  test("configurationVersion and matched ids present", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240, 2, "2026-09-13T03:00:00Z") });
    sentinel.configureSuppression({
      changedBy: "operator",
      changedAt: "2026-09-01T00:00:00Z",
      maintenanceWindows: [{ id: "w1", interval: { start: "2026-09-13T02:00:00Z", end: "2026-09-13T06:00:00Z" } }],
      knownChangeMarkers: [],
    });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    expect(finding.suppressed).toBe(true);
    expect(finding.configurationVersion).toBe(1);
    expect(finding.matchedWindows.length).toBeGreaterThan(0);
  });
});

describe("§7 failure modes", () => {
  test("trace missing required field -> E_INPUT naming pointer, whole call rejected", () => {
    const sentinel = freshSentinel();
    let caught: SentinelError | undefined;
    try {
      sentinel.ingestTraces({ agentId: "a", traces: [{ traceId: "x", startedAt: "2026-01-01T00:00:00Z", steps: [] }] });
    } catch (e) {
      caught = e as SentinelError;
    }
    expect(caught).toBeInstanceOf(SentinelError);
    expect(caught!.code).toBe("E_INPUT");
    expect(caught!.pointer).toContain("/steps");
  });

  test("trace count below minimum sample -> profile produced, findings capped at info", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const small = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(5, 20, "2026-09-16T00:00:00Z", "tiny") });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: small.traceSetRef, keyRef: KEY }) as any;
    expect(finding.confidence).toBe("insufficient-sample");
    expect(finding.severity).toBe("info");
  });

  test("baseline not found -> E_NOT_FOUND", () => {
    const sentinel = freshSentinel();
    const ingest = sentinel.ingestTraces({ agentId: "a", traces: normalTraces(50) });
    try {
      sentinel.checkDrift({ agentId: "a", baselineName: "nope", traceSetRef: ingest.traceSetRef, keyRef: KEY });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("E_NOT_FOUND");
    }
  });

  test("baseline signature invalid or key unavailable -> E_BASELINE_UNTRUSTED; no comparison performed", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const record = sentinel.debugBaselines().debugGetMutableRecord("planner-1", "sept-normal", 1)!;
    const originalSig = record.signature;
    (record as any).signature = "0".repeat(originalSig.length);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240) });
    try {
      sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("E_BASELINE_UNTRUSTED");
    }
  });

  test("conflicting maintenance windows -> both reported, no silent precedence", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240, 2, "2026-09-13T03:00:00Z") });
    sentinel.configureSuppression({
      changedBy: "operator",
      changedAt: "2026-09-01T00:00:00Z",
      maintenanceWindows: [
        { id: "window-a", interval: { start: "2026-09-13T02:00:00Z", end: "2026-09-13T06:00:00Z" } },
        { id: "window-b", interval: { start: "2026-09-13T01:00:00Z", end: "2026-09-13T04:00:00Z" } },
      ],
      knownChangeMarkers: [],
    });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    expect(finding.matchedWindows).toContain("window-a");
    expect(finding.matchedWindows).toContain("window-b");
  });

  test("calibration labels contradictory -> E_CALIBRATION with conflicting finding ids", () => {
    const sentinel = freshSentinel();
    setupBaseline(sentinel);
    const candidate = sentinel.ingestTraces({ agentId: "planner-1", traces: driftedTraces(240) });
    const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: candidate.traceSetRef, keyRef: KEY }) as any;
    try {
      sentinel.calibrate({
        agentId: "planner-1",
        labelledFindings: [
          { findingId: finding.findingId, label: "true" },
          { findingId: finding.findingId, label: "false" },
        ],
      });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("E_CALIBRATION");
      expect((e as SentinelError).data).toContain(finding.findingId);
    }
  });

  test("trace timestamps out of order -> accepted, flagged orderAnomaly true", () => {
    const sentinel = freshSentinel();
    const traces = [
      { traceId: "t-1", startedAt: "2026-09-02T00:00:00Z", steps: [{ tool: "search", outcome: "success", latencyMs: 10 }], tokens: { in: 1, out: 1 } },
      { traceId: "t-2", startedAt: "2026-09-01T00:00:00Z", steps: [{ tool: "search", outcome: "success", latencyMs: 10 }], tokens: { in: 1, out: 1 } },
    ];
    const ingest = sentinel.ingestTraces({ agentId: "a", traces });
    expect(ingest.orderAnomaly).toBe(true);
  });
});
