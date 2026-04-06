import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CallRecord } from "../types.js";
import { persistCallRecord } from "./store.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath: string, timeoutMs = 1000): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for ${filePath}`);
      }
      await delay(25);
    }
  }
}

function buildCall(overrides?: Partial<CallRecord>): CallRecord {
  return {
    callId: "store-call-1",
    providerCallId: "store-provider-1",
    provider: "twilio",
    direction: "outbound",
    state: "completed",
    from: "+49111111111",
    to: "+49222222222",
    startedAt: 1710000000000,
    endedAt: 1710000005000,
    endReason: "completed",
    transcript: [],
    processedEventIds: [],
    ...(overrides ?? {}),
  };
}

describe("persistCallRecord outcome projection", () => {
  it("writes terminal projected outcome to outcomes.jsonl", async () => {
    const storePath = await fs.mkdtemp(path.join(os.tmpdir(), "voice-call-outcomes-"));
    try {
      persistCallRecord(storePath, buildCall());
      const outcomeLog = await waitForFile(path.join(storePath, "outcomes.jsonl"));
      const lines = outcomeLog.split("\n").filter(Boolean);
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0] ?? "{}") as {
        callId?: string;
        contractVersion?: string;
      };
      expect(parsed.callId).toBe("store-call-1");
      expect(parsed.contractVersion).toBe("intake_outcome_v1");

      const pipelineStateRaw = await waitForFile(path.join(storePath, "kanzlei-pipeline-state.json"));
      const pipelineState = JSON.parse(pipelineStateRaw) as {
        calls?: Record<string, { callId?: string }>;
      };
      expect(pipelineState.calls?.["store-call-1"]?.callId).toBe("store-call-1");
    } finally {
      await fs.rm(storePath, { recursive: true, force: true });
    }
  });

  it("does not write projected outcome for non-terminal calls", async () => {
    const storePath = await fs.mkdtemp(path.join(os.tmpdir(), "voice-call-outcomes-"));
    try {
      persistCallRecord(
        storePath,
        buildCall({
          state: "active",
          endedAt: undefined,
          endReason: undefined,
        }),
      );

      await delay(100);
      await expect(fs.access(path.join(storePath, "outcomes.jsonl"))).rejects.toThrow();
    } finally {
      await fs.rm(storePath, { recursive: true, force: true });
    }
  });
});
