import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getKanzleiPipelineSnapshot,
  ingestOutcomeToDeterministicPipeline,
  processDeterministicPipeline,
  saveKanzleiAdminConfig,
  type OutcomeEnvelopeForPipeline,
} from "./deterministic-pipeline.js";

function buildOutcome(
  overrides?: Partial<OutcomeEnvelopeForPipeline>,
): OutcomeEnvelopeForPipeline {
  return {
    idempotencyKey: "voicecall:call-1:completed:1710000005000",
    callId: "call-1",
    providerCallId: "provider-1",
    from: "+49111111111",
    to: "+49222222222",
    startedAt: 1710000000000,
    endedAt: 1710000005000,
    terminalState: "completed",
    transcriptPreview: "Rueckruf wegen Kuendigung.",
    practiceArea: "arbeitsrecht",
    urgency: "high",
    callbackRequested: true,
    extractedContacts: {
      phones: ["017612345678"],
      emails: ["max@example.com"],
    },
    intakeProtocolValid: true,
    intakeProtocolErrors: [],
    intakeProtocolV1: {
      contractVersion: "intake_protocol_v1",
      case_id: "case-1",
      area: "arbeitsrecht",
      urgency: "high",
      callback_window: "today_0900_1200",
      caller: {
        phone: "017612345678",
        email: "max@example.com",
        name: "Max Mustermann",
        consent_to_contact: true,
      },
      summary: "Kuendigung erhalten.",
      safe_summary_for_low_trust_channels: "Rueckrufbitte arbeitsrecht.",
      dispatch_status: "queued",
      sla_deadline: 1710000900000,
      final_outcome: "pending_callback",
    },
    humanFallbackRequired: false,
    slaDeadlineAt: 1710000900000,
    generatedAt: 1710000009000,
    ...(overrides ?? {}),
  };
}

describe("deterministic pipeline", () => {
  it("fails closed for invalid intake payloads and only queues dashboard", async () => {
    const storePath = await fs.mkdtemp(path.join(os.tmpdir(), "voice-call-pipeline-"));
    try {
      const ingestResult = await ingestOutcomeToDeterministicPipeline(
        storePath,
        buildOutcome({
          idempotencyKey: "voicecall:call-invalid:completed:1710000005000",
          callId: "call-invalid",
          intakeProtocolValid: false,
          intakeProtocolErrors: ["missing_intake_protocol_v1_payload"],
          intakeProtocolV1: null,
          humanFallbackRequired: true,
          callbackRequested: false,
        }),
        1710000010000,
      );
      expect(ingestResult.ingested).toBe(true);
      expect(ingestResult.queuedChannels).toEqual(["dashboard"]);

      const processResult = await processDeterministicPipeline(storePath, 1710000010000);
      expect(processResult.processed).toBe(1);
      expect(processResult.sent).toBe(1);

      const snapshot = await getKanzleiPipelineSnapshot(storePath);
      expect(snapshot.summary.invalidPayloadCalls).toBe(1);
      expect(snapshot.summary.deadLetterOutbox).toBe(0);
      expect(snapshot.summary.sentOutbox).toBe(1);
      expect(snapshot.calls[0]?.intakeProtocolValid).toBe(false);
      expect(snapshot.calls[0]?.state).toBe("dispatched");
      expect(snapshot.recentAudit.some((entry) => entry.type === "validation_failed")).toBe(true);
      expect(snapshot.recentAudit.some((entry) => entry.type === "state_transition")).toBe(true);
    } finally {
      await fs.rm(storePath, { recursive: true, force: true });
    }
  });

  it("moves non-retryable exhausted dispatches into dead letter queue", async () => {
    const storePath = await fs.mkdtemp(path.join(os.tmpdir(), "voice-call-pipeline-"));
    try {
      await saveKanzleiAdminConfig(storePath, {
        version: "kanzlei_admin_v1",
        intakeRules: {
          allowedPracticeAreas: ["arbeitsrecht"],
          requiredFields: ["contractVersion", "case_id", "area", "urgency", "summary"],
          singleAgentOnly: true,
        },
        playbooks: {
          defaultQueueRoute: "kanzlei_default",
          priorityQueueRoute: "kanzlei_priority",
        },
        knowledgeBaseSources: ["kb://kanzlei/intake"],
        contactPolicies: {
          notifyByEmail: true,
          notifyByWhatsApp: true,
          lowTrustWhatsAppMode: "redacted_only",
          humanFallbackPhone: "+49123456789",
          humanFallbackEmail: "ops@example.com",
        },
        retryPolicy: {
          maxAttempts: 1,
          baseRetryDelayMs: 1_000,
        },
        memoryControls: {
          persistentFields: ["case_id", "summary"],
          ephemeralFields: ["transcriptPreview"],
          redactionRules: ["mask_contact_numbers_in_low_trust_channels"],
          retentionDays: 90,
        },
      });

      await ingestOutcomeToDeterministicPipeline(
        storePath,
        buildOutcome({
          idempotencyKey: "voicecall:call-dead:completed:1710000005000",
          callId: "call-dead",
          callbackRequested: false,
          extractedContacts: {
            phones: [],
            emails: ["max@example.com"],
          },
        }),
        1710000020000,
      );

      const processResult = await processDeterministicPipeline(storePath, 1710000020000);
      expect(processResult.processed).toBe(2);
      expect(processResult.deadLettered).toBe(1);

      const snapshot = await getKanzleiPipelineSnapshot(storePath);
      expect(snapshot.summary.deadLetterOutbox).toBe(1);
      expect(snapshot.summary.sentOutbox).toBe(1);
      expect(snapshot.deadLetters.length).toBe(1);
      expect(snapshot.deadLetters[0]?.channel).toBe("email");
      expect(snapshot.calls[0]?.state).toBe("dead_letter");
    } finally {
      await fs.rm(storePath, { recursive: true, force: true });
    }
  });
});
