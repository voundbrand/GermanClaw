import { describe, expect, it } from "vitest";
import type { CallRecord } from "./types.js";
import { projectIntakeOutcome } from "./outcome-pipeline.js";

function buildCall(overrides?: Partial<CallRecord>): CallRecord {
  return {
    callId: "call-1",
    providerCallId: "provider-1",
    provider: "twilio",
    direction: "outbound",
    state: "completed",
    from: "+49111111111",
    to: "+49222222222",
    startedAt: 1710000000000,
    endedAt: 1710000005000,
    endReason: "completed",
    transcript: [
      {
        timestamp: 1710000001000,
        speaker: "user",
        text: "Ich brauche einen Rueckruf. Es geht um eine Kuendigung mit Frist in 3 Wochen.",
        isFinal: true,
      },
      {
        timestamp: 1710000002000,
        speaker: "user",
        text: "Sie erreichen mich unter 017612345678 oder max@example.com.",
        isFinal: true,
      },
    ],
    processedEventIds: [],
    metadata: {
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
        summary: "Kuendigung erhalten, Rueckruf gewuenscht.",
        safe_summary_for_low_trust_channels: "Rueckruf zu arbeitsrechtlichem Anliegen.",
        dispatch_status: "queued",
        sla_deadline: 1710000900000,
        final_outcome: "pending_callback",
      },
    },
    ...(overrides ?? {}),
  };
}

describe("projectIntakeOutcome", () => {
  it("projects deterministic outcome envelope for terminal calls", () => {
    const projected = projectIntakeOutcome(buildCall(), 1710000009000);
    expect(projected).toBeTruthy();
    expect(projected?.contractVersion).toBe("intake_outcome_v1");
    expect(projected?.outcomeCategory).toBe("completed");
    expect(projected?.practiceArea).toBe("arbeitsrecht");
    expect(projected?.urgency).toBe("high");
    expect(projected?.callbackRequested).toBe(true);
    expect(projected?.dispatchReady).toBe(true);
    expect(projected?.intakeProtocolValid).toBe(true);
    expect(projected?.humanFallbackRequired).toBe(false);
    expect(projected?.suggestedChannels).toContain("dashboard");
    expect(projected?.suggestedChannels).toContain("email");
    expect(projected?.suggestedChannels).toContain("whatsapp");
    expect(projected?.extractedContacts.phones).toContain("017612345678");
    expect(projected?.extractedContacts.emails).toContain("max@example.com");
  });

  it("returns null for non-terminal calls", () => {
    const projected = projectIntakeOutcome(
      buildCall({
        state: "active",
        endedAt: undefined,
      }),
    );
    expect(projected).toBeNull();
  });

  it("fails closed when intake_protocol_v1 is missing", () => {
    const projected = projectIntakeOutcome(
      buildCall({
        metadata: {},
      }),
      1710000009000,
    );
    expect(projected).toBeTruthy();
    expect(projected?.intakeProtocolValid).toBe(false);
    expect(projected?.humanFallbackRequired).toBe(true);
    expect(projected?.suggestedChannels).toEqual(["dashboard"]);
  });
});
