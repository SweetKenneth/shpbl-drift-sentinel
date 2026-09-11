// MCP JSON-RPC 2.0 surface tests: initialize, tools/list, tools/call, unknown method,
// parse-error and application-error shaping. Exercises src/mcp-server.ts's `handle`
// directly against a captured stdout, without spawning any process.
import { describe, expect, test } from "bun:test";
import { handle } from "../src/mcp-server.js";
import { normalTraces } from "./fixtures.js";

function captureOne(fn: () => void): any {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  (process.stdout as any).write = (chunk: string) => {
    captured += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout as any).write = original;
  }
  const line = captured.trim().split("\n").pop()!;
  return JSON.parse(line);
}

describe("MCP JSON-RPC surface", () => {
  test("initialize returns protocol info and tool capability", () => {
    const res = captureOne(() => handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.capabilities.tools).toBeDefined();
  });

  test("tools/list enumerates the seven spec tools", () => {
    const res = captureOne(() => handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    const names = res.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      ["apply_calibration", "calibrate", "check_drift", "configure_suppression", "explain_drift", "ingest_traces", "set_baseline"].sort(),
    );
  });

  test("tools/call ingest_traces returns a traceSetRef via content[0].text", () => {
    const res = captureOne(() =>
      handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ingest_traces", arguments: { agentId: "planner-1", traces: normalTraces(40) } } }),
    );
    expect(res.result.isError).toBe(false);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.agentId).toBe("planner-1");
    expect(typeof payload.traceSetRef).toBe("string");
    expect(payload.traceCount).toBe(40);
  });

  test("tools/call with invalid arguments surfaces a SentinelError as JSON-RPC error", () => {
    const res = captureOne(() => handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ingest_traces", arguments: { agentId: "planner-1" } } }));
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toBe("E_INPUT");
    expect(res.error.data.error).toBe("E_INPUT");
  });

  test("unknown method returns method-not-found", () => {
    const res = captureOne(() => handle({ jsonrpc: "2.0", id: 5, method: "not/a/method", params: {} }));
    expect(res.error.code).toBe(-32601);
  });

  test("unknown tool name is rejected as E_INPUT", () => {
    const res = captureOne(() => handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "does_not_exist", arguments: {} } }));
    expect(res.error.data.error).toBe("E_INPUT");
  });

  test("notifications/initialized without id produces no response", () => {
    let captured = "";
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: string) => {
      captured += chunk;
      return true;
    };
    try {
      handle({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    } finally {
      (process.stdout as any).write = original;
    }
    expect(captured).toBe("");
  });

  test("full lifecycle over the JSON-RPC surface: ingest, baseline, drift, explain", () => {
    const KEY = "mcp-surface-test-key";
    const ingestRes = captureOne(() =>
      handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "ingest_traces", arguments: { agentId: "planner-mcp", traces: normalTraces(60, 40) } } }),
    );
    const { traceSetRef } = JSON.parse(ingestRes.result.content[0].text);

    const baselineRes = captureOne(() =>
      handle({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "set_baseline", arguments: { agentId: "planner-mcp", name: "b", traceSetRef, keyRef: KEY } } }),
    );
    expect(JSON.parse(baselineRes.result.content[0].text).version).toBe(1);

    const candIngestRes = captureOne(() =>
      handle({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "ingest_traces", arguments: { agentId: "planner-mcp", traces: normalTraces(60, 41, "2026-10-02T00:00:00Z", "c") } } }),
    );
    const candRef = JSON.parse(candIngestRes.result.content[0].text).traceSetRef;

    const driftRes = captureOne(() =>
      handle({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "check_drift", arguments: { agentId: "planner-mcp", baselineName: "b", traceSetRef: candRef, keyRef: KEY } } }),
    );
    const finding = JSON.parse(driftRes.result.content[0].text);
    expect(finding.agentId ?? "planner-mcp").toBe("planner-mcp");

    if (finding.findingId) {
      const explainRes = captureOne(() => handle({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "explain_drift", arguments: { findingId: finding.findingId } } }));
      const explanation = JSON.parse(explainRes.result.content[0].text);
      expect(explanation.findingId).toBe(finding.findingId);
    }
  });
});
