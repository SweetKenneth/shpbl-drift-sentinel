// Worked example: mirrors SPEC §9. A baseline is established from normal traffic, a
// configuration change causes shell.exec share and escalation rate to jump, and
// check_drift reports it unless it falls inside a declared maintenance window.
//
// Run with: bun examples/worked-example.ts
import { DriftSentinel } from "../src/index.js";

function makeTraces(count: number, opts: { shellShare: number; escalationRate: number; startAt: string; prefix: string }): unknown[] {
  const traces: unknown[] = [];
  const base = Date.parse(opts.startAt);
  for (let i = 0; i < count; i++) {
    const shellStep = Math.random() < opts.shellShare;
    const tool = shellStep ? "shell.exec" : Math.random() < 0.5 ? "search" : "doc.write";
    const escalation = shellStep && Math.random() < opts.escalationRate;
    traces.push({
      traceId: `${opts.prefix}-${String(i).padStart(4, "0")}`,
      startedAt: new Date(base + i * 60_000).toISOString(),
      steps: [
        { tool, outcome: escalation ? "refused" : "success", latencyMs: 50 + Math.round(Math.random() * 500), ...(escalation ? { escalation: true } : {}) },
        { tool: "search", outcome: "success", latencyMs: 120 },
      ],
      tokens: { in: 1200, out: 200 },
    });
  }
  return traces;
}

const sentinel = new DriftSentinel();
const keyRef = "worked-example-key";

const normal = makeTraces(812, { shellShare: 0.09, escalationRate: 0.004, startAt: "2026-08-01T00:00:00Z", prefix: "n" });
const ingestNormal = sentinel.ingestTraces({ agentId: "planner-1", traces: normal });
const baseline = sentinel.setBaseline({ agentId: "planner-1", name: "sept-normal", traceSetRef: ingestNormal.traceSetRef, keyRef });
console.log("baseline:", baseline);

const drifted = makeTraces(240, { shellShare: 0.34, escalationRate: 0.071, startAt: "2026-09-11T02:14:00Z", prefix: "d" });
const ingestDrift = sentinel.ingestTraces({ agentId: "planner-1", traces: drifted });
const finding = sentinel.checkDrift({ agentId: "planner-1", baselineName: "sept-normal", traceSetRef: ingestDrift.traceSetRef, keyRef }) as any;
console.log("finding:", JSON.stringify(finding, null, 2));

if (finding.findingId) {
  const explanation = sentinel.explainDrift({ findingId: finding.findingId });
  console.log("explanation:", JSON.stringify(explanation, null, 2));
}

// Declaring the maintenance window that covers this change would instead yield
// suppressed: true, with the matching window id and configuration version named
// (SPEC invariant 6), never a silently dropped finding.
