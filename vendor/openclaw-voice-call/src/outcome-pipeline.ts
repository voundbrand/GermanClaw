import fs from "node:fs/promises";
import path from "node:path";
import { z } from "openclaw/plugin-sdk/zod";
import {
  ingestOutcomeToDeterministicPipeline,
  processDeterministicPipeline,
  type OutcomeEnvelopeForPipeline,
} from "./deterministic-pipeline.js";
import { TerminalStates, type CallRecord, type CallState } from "./types.js";

export type IntakePracticeArea =
  | "arbeitsrecht"
  | "familienrecht"
  | "mietrecht"
  | "strafrecht"
  | "unclassified";

export type IntakeUrgency = "high" | "medium" | "low";

export type OutcomeCategory = "completed" | "unreached" | "failed" | "cancelled";

const IntakeProtocolV1Schema = z
  .object({
    contractVersion: z.literal("intake_protocol_v1"),
    case_id: z.string().min(1),
    area: z.string().min(1),
    urgency: z.enum(["high", "medium", "low"]),
    callback_window: z.string().min(1),
    caller: z.object({
      phone: z.string().optional(),
      email: z.string().optional(),
      name: z.string().optional(),
      consent_to_contact: z.boolean(),
    }),
    summary: z.string().min(1),
    safe_summary_for_low_trust_channels: z.string().min(1),
    dispatch_status: z.string().min(1),
    sla_deadline: z.number().int().positive(),
    final_outcome: z.string().min(1),
  })
  .strict();

type IntakeProtocolV1 = z.infer<typeof IntakeProtocolV1Schema>;

export interface IntakeOutcomeRecord extends OutcomeEnvelopeForPipeline {
  contractVersion: "intake_outcome_v1";
  provider: string;
  outcomeCategory: OutcomeCategory;
  transcriptTurnCount: number;
  dispatchReady: boolean;
  suggestedChannels: Array<"dashboard" | "email" | "whatsapp">;
}

const writtenOutcomeKeys = new Set<string>();

const PHONE_REGEX = /(?:\+|00)?\d[\d\s()./-]{7,}\d/g;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function extractPhones(text: string): string[] {
  const matches = text.match(PHONE_REGEX) ?? [];
  return uniqueValues(
    matches.map((value) => value.replace(/[^\d+]/g, "")).filter((value) => value.length >= 8),
  );
}

function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_REGEX) ?? [];
  return uniqueValues(matches.map((value) => value.toLowerCase()));
}

function detectPracticeArea(textLower: string): IntakePracticeArea {
  if (
    /\b(kundigung|kuendigung|arbeitsrecht|arbeitgeber|arbeitnehmer|abmahnung)\b/.test(textLower)
  ) {
    return "arbeitsrecht";
  }
  if (/\b(familienrecht|scheidung|sorgerecht|unterhalt|kindschaft)\b/.test(textLower)) {
    return "familienrecht";
  }
  if (/\b(mietrecht|miete|vermieter|mieter|nebenkosten)\b/.test(textLower)) {
    return "mietrecht";
  }
  if (/\b(strafrecht|polizei|festnahme|durchsuchung|haft)\b/.test(textLower)) {
    return "strafrecht";
  }
  return "unclassified";
}

function normalizePracticeArea(value: string): IntakePracticeArea {
  const normalized = value.trim().toLowerCase();
  if (normalized === "arbeitsrecht") {
    return "arbeitsrecht";
  }
  if (normalized === "familienrecht") {
    return "familienrecht";
  }
  if (normalized === "mietrecht") {
    return "mietrecht";
  }
  if (normalized === "strafrecht") {
    return "strafrecht";
  }
  return "unclassified";
}

function detectUrgency(textLower: string): IntakeUrgency {
  if (
    /\b(dringend|sofort|frist|heute|eilt|3[\s-]*wochen|festnahme|haft|durchsuchung)\b/.test(
      textLower,
    )
  ) {
    return "high";
  }
  if (/\b(rueckruf|ruckruf|zuruckrufen|callback|diese woche|morgen)\b/.test(textLower)) {
    return "medium";
  }
  return "low";
}

function isCallbackRequested(textLower: string): boolean {
  return /\b(rueckruf|ruckruf|zuruckruf|zuruckrufen|callback|rufen sie.*zuruck)\b/.test(textLower);
}

function mapOutcomeCategory(state: CallState): OutcomeCategory {
  switch (state) {
    case "completed":
    case "hangup-user":
      return "completed";
    case "hangup-bot":
      return "cancelled";
    case "no-answer":
    case "busy":
    case "voicemail":
      return "unreached";
    case "timeout":
    case "error":
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function buildIdempotencyKey(call: CallRecord): string {
  const terminalAt = call.endedAt ?? call.startedAt;
  return `voicecall:${call.callId}:${call.state}:${terminalAt}`;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tryExtractJsonPayload(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = tryParseJson(trimmed);
  if (direct) {
    return direct;
  }

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    const parsed = tryParseJson(fenced[1]);
    if (parsed) {
      return parsed;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParseJson(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function resolveProtocolCandidateFromMetadata(call: CallRecord): unknown | null {
  const metadata = call.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const keys = ["intakeProtocolV1", "intake_protocol_v1", "intakeProtocol"] as const;
  for (const key of keys) {
    const raw = metadata[key];
    if (!raw) {
      continue;
    }
    if (typeof raw === "string") {
      const parsed = tryExtractJsonPayload(raw);
      if (parsed) {
        return parsed;
      }
      continue;
    }
    if (typeof raw === "object") {
      return raw;
    }
  }

  return null;
}

function resolveProtocolCandidateFromTranscript(call: CallRecord): unknown | null {
  for (let index = call.transcript.length - 1; index >= 0; index -= 1) {
    const entry = call.transcript[index];
    if (!entry?.text || !entry.text.includes("intake_protocol_v1")) {
      continue;
    }
    const parsed = tryExtractJsonPayload(entry.text);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function resolveIntakeProtocol(call: CallRecord): {
  intakeProtocolV1: IntakeProtocolV1 | null;
  intakeProtocolErrors: string[];
} {
  const candidate =
    resolveProtocolCandidateFromMetadata(call) ?? resolveProtocolCandidateFromTranscript(call);
  if (!candidate) {
    return {
      intakeProtocolV1: null,
      intakeProtocolErrors: ["missing_intake_protocol_v1_payload"],
    };
  }

  const parsed = IntakeProtocolV1Schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      intakeProtocolV1: null,
      intakeProtocolErrors: parsed.error.issues.map((issue) => {
        const key = issue.path.length ? issue.path.join(".") : "payload";
        return `${key}: ${issue.message}`;
      }),
    };
  }

  return {
    intakeProtocolV1: parsed.data,
    intakeProtocolErrors: [],
  };
}

function callbackWindowRequestsCallback(callbackWindow: string): boolean {
  const normalized = callbackWindow.trim().toLowerCase();
  return !["", "none", "no", "no_callback", "not_requested"].includes(normalized);
}

function computeFallbackSlaDeadline(endedAt: number, urgency: IntakeUrgency): number {
  if (urgency === "high") {
    return endedAt + 15 * 60_000;
  }
  if (urgency === "medium") {
    return endedAt + 2 * 60 * 60_000;
  }
  return endedAt + 8 * 60 * 60_000;
}

export function projectIntakeOutcome(
  call: CallRecord,
  generatedAt = Date.now(),
): IntakeOutcomeRecord | null {
  if (!TerminalStates.has(call.state) || typeof call.endedAt !== "number") {
    return null;
  }

  const transcriptText = normalizeWhitespace(call.transcript.map((entry) => entry.text).join(" "));
  const transcriptLower = transcriptText.toLowerCase();
  const transcriptTurnCount = call.transcript.length;

  const protocolResult = resolveIntakeProtocol(call);
  const intakeProtocolV1 = protocolResult.intakeProtocolV1;

  const detectedPracticeArea = detectPracticeArea(transcriptLower);
  const practiceArea = intakeProtocolV1
    ? normalizePracticeArea(intakeProtocolV1.area)
    : detectedPracticeArea;
  const urgency = intakeProtocolV1 ? intakeProtocolV1.urgency : detectUrgency(transcriptLower);
  const callbackRequestedFromSpeech = isCallbackRequested(transcriptLower);
  const callbackRequestedFromProtocol = intakeProtocolV1
    ? callbackWindowRequestsCallback(intakeProtocolV1.callback_window)
    : false;
  const callbackRequested = callbackRequestedFromProtocol || callbackRequestedFromSpeech;

  const extractedContacts = {
    phones: uniqueValues([
      ...extractPhones(transcriptText),
      intakeProtocolV1?.caller.phone ?? "",
    ]),
    emails: uniqueValues([
      ...extractEmails(transcriptText),
      intakeProtocolV1?.caller.email ?? "",
    ]),
  };

  const intakeProtocolErrors = [...protocolResult.intakeProtocolErrors];
  if (intakeProtocolV1 && !intakeProtocolV1.caller.consent_to_contact) {
    intakeProtocolErrors.push("caller_consent_to_contact_false");
  }
  if (callbackRequested && extractedContacts.phones.length === 0) {
    intakeProtocolErrors.push("callback_requested_without_phone_contact");
  }

  const intakeProtocolValid = intakeProtocolErrors.length === 0 && Boolean(intakeProtocolV1);
  const humanFallbackRequired = !intakeProtocolValid;
  const dispatchReady = intakeProtocolValid && !humanFallbackRequired;

  const suggestedChannels: Array<"dashboard" | "email" | "whatsapp"> = ["dashboard"];
  if (dispatchReady && extractedContacts.emails.length > 0) {
    suggestedChannels.push("email");
  }
  if (dispatchReady && callbackRequested && extractedContacts.phones.length > 0) {
    suggestedChannels.push("whatsapp");
  }

  const outcomeCategory = mapOutcomeCategory(call.state);
  const slaDeadlineAt = intakeProtocolV1?.sla_deadline ?? computeFallbackSlaDeadline(call.endedAt, urgency);

  return {
    contractVersion: "intake_outcome_v1",
    idempotencyKey: buildIdempotencyKey(call),
    callId: call.callId,
    providerCallId: call.providerCallId,
    provider: call.provider,
    from: call.from,
    to: call.to,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    terminalState: call.state,
    outcomeCategory,
    transcriptTurnCount,
    transcriptPreview: transcriptText.slice(0, 280),
    practiceArea,
    urgency,
    callbackRequested,
    extractedContacts,
    intakeProtocolValid,
    intakeProtocolErrors: uniqueValues(intakeProtocolErrors),
    intakeProtocolV1,
    humanFallbackRequired,
    dispatchReady,
    suggestedChannels,
    slaDeadlineAt,
    generatedAt,
  };
}

export async function persistProjectedOutcome(storePath: string, call: CallRecord): Promise<void> {
  const outcome = projectIntakeOutcome(call);
  if (!outcome) {
    return;
  }

  if (writtenOutcomeKeys.has(outcome.idempotencyKey)) {
    return;
  }
  writtenOutcomeKeys.add(outcome.idempotencyKey);

  const outcomePath = path.join(storePath, "outcomes.jsonl");
  await fs.appendFile(outcomePath, `${JSON.stringify(outcome)}\n`, "utf8");

  await ingestOutcomeToDeterministicPipeline(storePath, {
    idempotencyKey: outcome.idempotencyKey,
    callId: outcome.callId,
    providerCallId: outcome.providerCallId,
    from: outcome.from,
    to: outcome.to,
    startedAt: outcome.startedAt,
    endedAt: outcome.endedAt,
    terminalState: outcome.terminalState,
    transcriptPreview: outcome.transcriptPreview,
    practiceArea: outcome.practiceArea,
    urgency: outcome.urgency,
    callbackRequested: outcome.callbackRequested,
    extractedContacts: outcome.extractedContacts,
    intakeProtocolValid: outcome.intakeProtocolValid,
    intakeProtocolErrors: outcome.intakeProtocolErrors,
    intakeProtocolV1: outcome.intakeProtocolV1,
    humanFallbackRequired: outcome.humanFallbackRequired,
    slaDeadlineAt: outcome.slaDeadlineAt,
    generatedAt: outcome.generatedAt,
  });

  await processDeterministicPipeline(storePath);
}
