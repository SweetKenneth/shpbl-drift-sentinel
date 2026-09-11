// Tool surface shared by the MCP server. Six tools, SPEC §3.
import { DriftSentinel } from "./sentinel.js";
import { Json, SentinelError } from "./canonical.js";

export const TOOLS = [
  { name: "ingest_traces", description: "Ingest caller-supplied agent execution traces and return a traceSetRef.",
    inputSchema: { type: "object", required: ["agentId", "traces"], properties: { agentId: { type: "string" }, traces: { type: "array" } } } },
  { name: "set_baseline", description: "Sign and store a behaviour profile as a named baseline version.",
    inputSchema: { type: "object", required: ["agentId", "name", "traceSetRef", "keyRef"], properties: { agentId: { type: "string" }, name: { type: "string" }, traceSetRef: { type: "string" }, keyRef: { type: "string" } } } },
  { name: "check_drift", description: "Compare a trace set against a signed baseline and report divergence.",
    inputSchema: { type: "object", required: ["agentId", "baselineName", "traceSetRef", "keyRef"], properties: { agentId: { type: "string" }, baselineName: { type: "string" }, traceSetRef: { type: "string" }, keyRef: { type: "string" } } } },
  { name: "explain_drift", description: "Dimension-level attribution plus replay of the most divergent episode.",
    inputSchema: { type: "object", required: ["findingId"], properties: { findingId: { type: "string" } } } },
  { name: "calibrate", description: "Propose a calibration profile from labelled findings; never mutates thresholds.",
    inputSchema: { type: "object", required: ["agentId", "labelledFindings"], properties: { agentId: { type: "string" }, labelledFindings: { type: "array" } } } },
  { name: "apply_calibration", description: "Create a new signed baseline version carrying an approved calibration profile.",
    inputSchema: { type: "object", required: ["agentId", "baselineName", "baselineVersion", "calibrationProfileRef", "keyRef"], properties: {} } },
  { name: "configure_suppression", description: "Declare maintenance windows and known change markers.",
    inputSchema: { type: "object", properties: {} } },
] as const;

export function callTool(sentinel: DriftSentinel, name: string, args: any): Json {
  switch (name) {
    case "ingest_traces": return sentinel.ingestTraces(args) as unknown as Json;
    case "set_baseline": return sentinel.setBaseline(args) as unknown as Json;
    case "check_drift": return sentinel.checkDrift(args) as unknown as Json;
    case "explain_drift": return sentinel.explainDrift(args) as unknown as Json;
    case "calibrate": return sentinel.calibrate(args) as unknown as Json;
    case "apply_calibration": return sentinel.applyCalibration(args) as unknown as Json;
    case "configure_suppression": return sentinel.configureSuppression(args) as unknown as Json;
    default: throw new SentinelError("E_INPUT", "unknown tool", "name");
  }
}
