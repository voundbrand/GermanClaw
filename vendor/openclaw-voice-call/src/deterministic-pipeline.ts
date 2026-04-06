import fs from "node:fs/promises";
import path from "node:path";
import { z } from "openclaw/plugin-sdk/zod";

export type DispatchChannel = "dashboard" | "email" | "whatsapp";

export type OutcomeEnvelopeForPipeline = {
  idempotencyKey: string;
  callId: string;
  providerCallId?: string;
  from: string;
  to: string;
  startedAt: number;
  endedAt: number;
  terminalState: string;
  transcriptPreview: string;
  practiceArea: string;
  urgency: string;
  callbackRequested: boolean;
  extractedContacts: {
    phones: string[];
    emails: string[];
  };
  intakeProtocolValid: boolean;
  intakeProtocolErrors: string[];
  intakeProtocolV1: {
    contractVersion: "intake_protocol_v1";
    case_id: string;
    area: string;
    urgency: string;
    callback_window: string;
    caller: {
      phone?: string;
      email?: string;
      name?: string;
      consent_to_contact: boolean;
    };
    summary: string;
    safe_summary_for_low_trust_channels: string;
    dispatch_status: string;
    sla_deadline: number;
    final_outcome: string;
  } | null;
  humanFallbackRequired: boolean;
  slaDeadlineAt: number | null;
  generatedAt: number;
};

export type KanzleiPipelineCallState =
  | "received"
  | "validated"
  | "invalid_payload"
  | "queued"
  | "dispatching"
  | "dispatched"
  | "retry_pending"
  | "dead_letter";

export type KanzleiOutboxState = "queued" | "retry_pending" | "sent" | "dead_letter";

export type KanzleiAuditEventType =
  | "db_write"
  | "validation_passed"
  | "validation_failed"
  | "queue_enqueued"
  | "dispatch_attempt"
  | "dispatch_sent"
  | "dispatch_retry_scheduled"
  | "dispatch_dead_lettered"
  | "sla_deadline_set"
  | "sla_breached"
  | "state_transition";

export type KanzleiPipelineCall = {
  callId: string;
  providerCallId?: string;
  caseId: string;
  state: KanzleiPipelineCallState;
  createdAt: number;
  updatedAt: number;
  urgency: string;
  practiceArea: string;
  humanFallbackRequired: boolean;
  intakeProtocolValid: boolean;
  intakeProtocolErrors: string[];
  callbackRequested: boolean;
  callbackWindow: string;
  finalOutcome: string;
  slaDeadlineAt: number | null;
  slaBreached: boolean;
};

export type KanzleiOutboxEntry = {
  id: string;
  idempotencyKey: string;
  callId: string;
  caseId: string;
  channel: DispatchChannel;
  state: KanzleiOutboxState;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError?: string;
  lastAttemptAt?: number;
  sentAt?: number;
  payload: Record<string, unknown>;
};

export type KanzleiDeadLetterEntry = {
  id: string;
  callId: string;
  caseId: string;
  channel: DispatchChannel;
  attempts: number;
  reason: string;
  lastAttemptAt: number;
  payload: Record<string, unknown>;
};

export type KanzleiAuditEvent = {
  idempotencyKey: string;
  callId: string;
  caseId: string;
  type: KanzleiAuditEventType;
  channel?: DispatchChannel;
  message: string;
  metadata?: Record<string, unknown>;
  ts: number;
};

export type KanzleiAdminConfig = {
  version: "kanzlei_admin_v1";
  intakeRules: {
    allowedPracticeAreas: string[];
    requiredFields: string[];
    singleAgentOnly: boolean;
  };
  playbooks: {
    defaultQueueRoute: string;
    priorityQueueRoute: string;
  };
  knowledgeBaseSources: string[];
  contactPolicies: {
    notifyByEmail: boolean;
    notifyByWhatsApp: boolean;
    lowTrustWhatsAppMode: "redacted_only";
    humanFallbackPhone: string;
    humanFallbackEmail: string;
  };
  retryPolicy: {
    maxAttempts: number;
    baseRetryDelayMs: number;
  };
  memoryControls: {
    persistentFields: string[];
    ephemeralFields: string[];
    redactionRules: string[];
    retentionDays: number;
  };
};

export type KanzleiPipelineSnapshot = {
  contractVersion: "kanzlei_pipeline_snapshot_v1";
  generatedAt: number;
  summary: {
    totalCalls: number;
    validatedCalls: number;
    invalidPayloadCalls: number;
    queuedOutbox: number;
    retryPendingOutbox: number;
    deadLetterOutbox: number;
    sentOutbox: number;
    slaBreaches: number;
  };
  calls: KanzleiPipelineCall[];
  outbox: KanzleiOutboxEntry[];
  deadLetters: KanzleiDeadLetterEntry[];
  recentAudit: KanzleiAuditEvent[];
  adminConfig: KanzleiAdminConfig;
};

type DeterministicPipelineState = {
  contractVersion: "kanzlei_pipeline_state_v1";
  processedOutcomeKeys: string[];
  processedStepKeys: string[];
  calls: Record<string, KanzleiPipelineCall>;
  outbox: KanzleiOutboxEntry[];
  deadLetters: KanzleiDeadLetterEntry[];
  updatedAt: number;
};

const STATE_FILE = "kanzlei-pipeline-state.json";
const AUDIT_FILE = "kanzlei-audit.jsonl";
const DB_FILE = "kanzlei-intake-db.jsonl";
const ADMIN_FILE = "kanzlei-admin-config.json";

const DEFAULT_ADMIN_CONFIG: KanzleiAdminConfig = {
  version: "kanzlei_admin_v1",
  intakeRules: {
    allowedPracticeAreas: ["arbeitsrecht", "familienrecht", "mietrecht", "strafrecht"],
    requiredFields: [
      "contractVersion",
      "case_id",
      "area",
      "urgency",
      "callback_window",
      "summary",
    ],
    singleAgentOnly: true,
  },
  playbooks: {
    defaultQueueRoute: "kanzlei_intake_default",
    priorityQueueRoute: "kanzlei_intake_priority",
  },
  knowledgeBaseSources: ["kb://kanzlei/intake-playbook", "kb://kanzlei/contact-policy"],
  contactPolicies: {
    notifyByEmail: true,
    notifyByWhatsApp: true,
    lowTrustWhatsAppMode: "redacted_only",
    humanFallbackPhone: "",
    humanFallbackEmail: "",
  },
  retryPolicy: {
    maxAttempts: 3,
    baseRetryDelayMs: 60_000,
  },
  memoryControls: {
    persistentFields: ["case_id", "area", "urgency", "callback_window", "summary"],
    ephemeralFields: ["transcriptPreview"],
    redactionRules: ["mask_contact_numbers_in_low_trust_channels"],
    retentionDays: 90,
  },
};

const adminConfigSchema = z
  .object({
    version: z.literal("kanzlei_admin_v1"),
    intakeRules: z.object({
      allowedPracticeAreas: z.array(z.string().min(1)),
      requiredFields: z.array(z.string().min(1)),
      singleAgentOnly: z.boolean(),
    }),
    playbooks: z.object({
      defaultQueueRoute: z.string().min(1),
      priorityQueueRoute: z.string().min(1),
    }),
    knowledgeBaseSources: z.array(z.string().min(1)),
    contactPolicies: z.object({
      notifyByEmail: z.boolean(),
      notifyByWhatsApp: z.boolean(),
      lowTrustWhatsAppMode: z.literal("redacted_only"),
      humanFallbackPhone: z.string(),
      humanFallbackEmail: z.string(),
    }),
    retryPolicy: z.object({
      maxAttempts: z.number().int().min(1).max(10),
      baseRetryDelayMs: z.number().int().min(1_000).max(86_400_000),
    }),
    memoryControls: z.object({
      persistentFields: z.array(z.string().min(1)),
      ephemeralFields: z.array(z.string().min(1)),
      redactionRules: z.array(z.string().min(1)),
      retentionDays: z.number().int().min(1).max(3650),
    }),
  })
  .strict();

function createDefaultState(): DeterministicPipelineState {
  return {
    contractVersion: "kanzlei_pipeline_state_v1",
    processedOutcomeKeys: [],
    processedStepKeys: [],
    calls: {},
    outbox: [],
    deadLetters: [],
    updatedAt: Date.now(),
  };
}

function statePath(storePath: string): string {
  return path.join(storePath, STATE_FILE);
}

function auditPath(storePath: string): string {
  return path.join(storePath, AUDIT_FILE);
}

function dbPath(storePath: string): string {
  return path.join(storePath, DB_FILE);
}

function adminPath(storePath: string): string {
  return path.join(storePath, ADMIN_FILE);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isStepAlreadyProcessed(state: DeterministicPipelineState, key: string): boolean {
  return state.processedStepKeys.includes(key);
}

function markStepProcessed(state: DeterministicPipelineState, key: string): void {
  if (!isStepAlreadyProcessed(state, key)) {
    state.processedStepKeys.push(key);
  }
}

function transitionCallState(
  state: DeterministicPipelineState,
  params: {
    callId: string;
    stepKey: string;
    nextState: KanzleiPipelineCallState;
    now: number;
  },
): boolean {
  const call = state.calls[params.callId];
  if (!call) {
    return false;
  }

  const allowed: Record<KanzleiPipelineCallState, KanzleiPipelineCallState[]> = {
    received: ["validated", "invalid_payload"],
    validated: ["queued", "dispatching"],
    invalid_payload: ["queued", "dispatching"],
    queued: ["dispatching", "retry_pending", "dead_letter", "dispatched"],
    dispatching: ["dispatched", "retry_pending", "dead_letter"],
    dispatched: ["dispatched"],
    retry_pending: ["dispatching", "retry_pending", "dead_letter", "dispatched"],
    dead_letter: ["dead_letter"],
  };

  if (!allowed[call.state].includes(params.nextState)) {
    return false;
  }

  const stepKey = `call:${params.callId}:step:${params.stepKey}`;
  if (isStepAlreadyProcessed(state, stepKey)) {
    return false;
  }

  call.state = params.nextState;
  call.updatedAt = params.now;
  markStepProcessed(state, stepKey);
  return true;
}

async function transitionCallStateWithAudit(params: {
  storePath: string;
  state: DeterministicPipelineState;
  callId: string;
  caseId: string;
  stepKey: string;
  nextState: KanzleiPipelineCallState;
  now: number;
  reason: string;
}): Promise<boolean> {
  const call = params.state.calls[params.callId];
  if (!call) {
    return false;
  }

  const previousState = call.state;
  const transitioned = transitionCallState(params.state, {
    callId: params.callId,
    stepKey: params.stepKey,
    nextState: params.nextState,
    now: params.now,
  });
  if (!transitioned) {
    return false;
  }

  await appendAuditEvent(params.storePath, {
    idempotencyKey: `audit:${params.callId}:state:${params.stepKey}`,
    callId: params.callId,
    caseId: params.caseId,
    type: "state_transition",
    message: `State transition ${previousState} -> ${params.nextState}: ${params.reason}`,
    metadata: {
      from: previousState,
      to: params.nextState,
      stepKey: params.stepKey,
    },
    ts: params.now,
  });
  return true;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readPipelineState(storePath: string): Promise<DeterministicPipelineState> {
  const parsed = await readJsonFile<DeterministicPipelineState>(statePath(storePath));
  if (!parsed || parsed.contractVersion !== "kanzlei_pipeline_state_v1") {
    return createDefaultState();
  }
  return {
    ...createDefaultState(),
    ...parsed,
    processedOutcomeKeys: uniqueStrings(parsed.processedOutcomeKeys ?? []),
    processedStepKeys: uniqueStrings(parsed.processedStepKeys ?? []),
    calls: parsed.calls ?? {},
    outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
    deadLetters: Array.isArray(parsed.deadLetters) ? parsed.deadLetters : [],
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
  };
}

async function writePipelineState(storePath: string, state: DeterministicPipelineState): Promise<void> {
  await fs.mkdir(storePath, { recursive: true });
  await fs.writeFile(
    statePath(storePath),
    `${JSON.stringify(
      {
        ...state,
        updatedAt: Date.now(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function appendJsonl(filePath: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function appendAuditEvent(storePath: string, event: KanzleiAuditEvent): Promise<void> {
  await appendJsonl(auditPath(storePath), event);
}

function mapChannelPayload(params: {
  channel: DispatchChannel;
  call: KanzleiPipelineCall;
  outcome: OutcomeEnvelopeForPipeline;
}): Record<string, unknown> {
  const base = {
    callId: params.call.callId,
    caseId: params.call.caseId,
    urgency: params.call.urgency,
    callbackWindow: params.call.callbackWindow,
    generatedAt: params.outcome.generatedAt,
  };

  if (params.channel === "whatsapp") {
    return {
      ...base,
      // Low-trust channel: never include full summary/transcript.
      safeSummary:
        params.outcome.intakeProtocolV1?.safe_summary_for_low_trust_channels ||
        "R\u00fcckrufbitte eingegangen. Bitte Dashboard ansehen.",
    };
  }

  if (params.channel === "email") {
    return {
      ...base,
      summary: params.outcome.intakeProtocolV1?.summary || params.outcome.transcriptPreview,
      callbackRequested: params.call.callbackRequested,
      practiceArea: params.call.practiceArea,
    };
  }

  return {
    ...base,
    summary: params.outcome.intakeProtocolV1?.summary || params.outcome.transcriptPreview,
    practiceArea: params.call.practiceArea,
    humanFallbackRequired: params.call.humanFallbackRequired,
    intakeProtocolValid: params.call.intakeProtocolValid,
  };
}

function computeSlaDeadline(outcome: OutcomeEnvelopeForPipeline): number | null {
  if (typeof outcome.slaDeadlineAt === "number") {
    return outcome.slaDeadlineAt;
  }

  const start = typeof outcome.endedAt === "number" ? outcome.endedAt : outcome.generatedAt;
  switch (outcome.urgency) {
    case "high":
      return start + 15 * 60_000;
    case "medium":
      return start + 2 * 60 * 60_000;
    default:
      return start + 8 * 60 * 60_000;
  }
}

function computeCaseId(outcome: OutcomeEnvelopeForPipeline): string {
  return outcome.intakeProtocolV1?.case_id || `${outcome.callId}-fallback`;
}

function computeCallbackWindow(outcome: OutcomeEnvelopeForPipeline): string {
  return outcome.intakeProtocolV1?.callback_window || "unknown";
}

function shouldQueueChannel(
  channel: DispatchChannel,
  outcome: OutcomeEnvelopeForPipeline,
  admin: KanzleiAdminConfig,
): boolean {
  if (outcome.humanFallbackRequired && channel !== "dashboard") {
    return false;
  }

  if (channel === "dashboard") {
    return true;
  }

  if (channel === "email") {
    if (!admin.contactPolicies.notifyByEmail) {
      return false;
    }
    return Boolean(outcome.extractedContacts.emails[0] || outcome.intakeProtocolV1?.caller.email);
  }

  if (!admin.contactPolicies.notifyByWhatsApp) {
    return false;
  }

  if (!outcome.callbackRequested) {
    return false;
  }

  return Boolean(outcome.extractedContacts.phones[0] || outcome.intakeProtocolV1?.caller.phone);
}

function toCallRecord(outcome: OutcomeEnvelopeForPipeline, now: number): KanzleiPipelineCall {
  return {
    callId: outcome.callId,
    providerCallId: outcome.providerCallId,
    caseId: computeCaseId(outcome),
    state: "received",
    createdAt: now,
    updatedAt: now,
    urgency: outcome.urgency,
    practiceArea: outcome.practiceArea,
    humanFallbackRequired: outcome.humanFallbackRequired,
    intakeProtocolValid: outcome.intakeProtocolValid,
    intakeProtocolErrors: outcome.intakeProtocolErrors,
    callbackRequested: outcome.callbackRequested,
    callbackWindow: computeCallbackWindow(outcome),
    finalOutcome: outcome.intakeProtocolV1?.final_outcome || "pending_callback",
    slaDeadlineAt: computeSlaDeadline(outcome),
    slaBreached: false,
  };
}

function makeOutboxEntry(params: {
  outcome: OutcomeEnvelopeForPipeline;
  call: KanzleiPipelineCall;
  channel: DispatchChannel;
  admin: KanzleiAdminConfig;
  now: number;
}): KanzleiOutboxEntry {
  const id = `${params.call.callId}:${params.channel}`;
  return {
    id,
    idempotencyKey: `outbox:${id}:v1`,
    callId: params.call.callId,
    caseId: params.call.caseId,
    channel: params.channel,
    state: "queued",
    attempts: 0,
    maxAttempts: params.admin.retryPolicy.maxAttempts,
    nextAttemptAt: params.now,
    payload: mapChannelPayload({
      channel: params.channel,
      call: params.call,
      outcome: params.outcome,
    }),
  };
}

function computeBackoffMs(baseDelayMs: number, attempt: number): number {
  const factor = Math.max(0, attempt - 1);
  return baseDelayMs * 2 ** factor;
}

type DispatchAttemptResult = {
  ok: boolean;
  retryable: boolean;
  reason?: string;
};

async function appendDispatchRecord(
  storePath: string,
  channel: DispatchChannel,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendJsonl(path.join(storePath, `kanzlei-dispatch-${channel}.jsonl`), payload);
}

async function attemptDispatch(params: {
  storePath: string;
  admin: KanzleiAdminConfig;
  call: KanzleiPipelineCall;
  entry: KanzleiOutboxEntry;
  now: number;
}): Promise<DispatchAttemptResult> {
  if (params.entry.channel === "email") {
    if (!params.admin.contactPolicies.notifyByEmail) {
      return { ok: false, retryable: false, reason: "email_disabled" };
    }
  }

  if (params.entry.channel === "whatsapp") {
    if (!params.admin.contactPolicies.notifyByWhatsApp) {
      return { ok: false, retryable: false, reason: "whatsapp_disabled" };
    }
  }

  // Deterministic failure simulation for real-world retry/DLQ drills.
  if (params.entry.channel !== "dashboard" && params.entry.attempts === 1) {
    return { ok: false, retryable: true, reason: "transport_temporarily_unavailable" };
  }

  await appendDispatchRecord(params.storePath, params.entry.channel, {
    idempotencyKey: params.entry.idempotencyKey,
    callId: params.entry.callId,
    caseId: params.entry.caseId,
    channel: params.entry.channel,
    payload: params.entry.payload,
    sentAt: params.now,
  });

  return { ok: true, retryable: false };
}

function countByState(outbox: KanzleiOutboxEntry[]) {
  const queuedOutbox = outbox.filter((entry) => entry.state === "queued").length;
  const retryPendingOutbox = outbox.filter((entry) => entry.state === "retry_pending").length;
  const deadLetterOutbox = outbox.filter((entry) => entry.state === "dead_letter").length;
  const sentOutbox = outbox.filter((entry) => entry.state === "sent").length;
  return {
    queuedOutbox,
    retryPendingOutbox,
    deadLetterOutbox,
    sentOutbox,
  };
}

function extractCaseIdFromCall(state: DeterministicPipelineState, callId: string): string {
  return state.calls[callId]?.caseId || `${callId}-unknown`;
}

async function readAuditTail(storePath: string, limit: number): Promise<KanzleiAuditEvent[]> {
  try {
    const raw = await fs.readFile(auditPath(storePath), "utf8");
    const lines = raw.split("\n").filter(Boolean).slice(-limit);
    const parsed: KanzleiAuditEvent[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as KanzleiAuditEvent);
      } catch {
        // ignore malformed rows
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export async function loadKanzleiAdminConfig(storePath: string): Promise<KanzleiAdminConfig> {
  const parsed = await readJsonFile<KanzleiAdminConfig>(adminPath(storePath));
  if (!parsed) {
    await saveKanzleiAdminConfig(storePath, DEFAULT_ADMIN_CONFIG);
    return DEFAULT_ADMIN_CONFIG;
  }
  const validated = adminConfigSchema.safeParse(parsed);
  if (!validated.success) {
    await saveKanzleiAdminConfig(storePath, DEFAULT_ADMIN_CONFIG);
    return DEFAULT_ADMIN_CONFIG;
  }
  return {
    ...validated.data,
    intakeRules: {
      ...validated.data.intakeRules,
      allowedPracticeAreas: uniqueStrings(validated.data.intakeRules.allowedPracticeAreas),
      requiredFields: uniqueStrings(validated.data.intakeRules.requiredFields),
    },
    knowledgeBaseSources: uniqueStrings(validated.data.knowledgeBaseSources),
    memoryControls: {
      ...validated.data.memoryControls,
      persistentFields: uniqueStrings(validated.data.memoryControls.persistentFields),
      ephemeralFields: uniqueStrings(validated.data.memoryControls.ephemeralFields),
      redactionRules: uniqueStrings(validated.data.memoryControls.redactionRules),
    },
  };
}

export async function saveKanzleiAdminConfig(
  storePath: string,
  config: KanzleiAdminConfig,
): Promise<KanzleiAdminConfig> {
  const validated = adminConfigSchema.parse(config);
  await fs.mkdir(storePath, { recursive: true });
  await fs.writeFile(adminPath(storePath), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return validated;
}

export async function ingestOutcomeToDeterministicPipeline(
  storePath: string,
  outcome: OutcomeEnvelopeForPipeline,
  now = Date.now(),
): Promise<{ ingested: boolean; queuedChannels: DispatchChannel[]; callId: string }> {
  const state = await readPipelineState(storePath);
  const admin = await loadKanzleiAdminConfig(storePath);

  if (state.processedOutcomeKeys.includes(outcome.idempotencyKey)) {
    return { ingested: false, queuedChannels: [], callId: outcome.callId };
  }

  state.processedOutcomeKeys.push(outcome.idempotencyKey);

  const call = toCallRecord(outcome, now);
  state.calls[call.callId] = call;

  await appendJsonl(dbPath(storePath), {
    contractVersion: "kanzlei_intake_db_v1",
    callId: call.callId,
    caseId: call.caseId,
    intakeProtocolValid: outcome.intakeProtocolValid,
    intakeProtocolErrors: outcome.intakeProtocolErrors,
    intakeProtocolV1: outcome.intakeProtocolV1,
    humanFallbackRequired: outcome.humanFallbackRequired,
    transcriptPreview: outcome.transcriptPreview,
    createdAt: now,
  });

  await appendAuditEvent(storePath, {
    idempotencyKey: `audit:${call.callId}:db_write`,
    callId: call.callId,
    caseId: call.caseId,
    type: "db_write",
    message: "Persisted intake record to deterministic intake DB.",
    metadata: {
      intakeProtocolValid: outcome.intakeProtocolValid,
    },
    ts: now,
  });

  const validationTransition = await transitionCallStateWithAudit({
    storePath,
    state,
    callId: call.callId,
    caseId: call.caseId,
    stepKey: "validation",
    nextState: outcome.intakeProtocolValid ? "validated" : "invalid_payload",
    now,
    reason: outcome.intakeProtocolValid ? "payload_valid" : "payload_invalid",
  });

  if (validationTransition) {
    await appendAuditEvent(storePath, {
      idempotencyKey: `audit:${call.callId}:validation:${outcome.intakeProtocolValid ? "passed" : "failed"}`,
      callId: call.callId,
      caseId: call.caseId,
      type: outcome.intakeProtocolValid ? "validation_passed" : "validation_failed",
      message: outcome.intakeProtocolValid
        ? "Validated intake_protocol_v1 payload."
        : "Invalid intake_protocol_v1 payload. Human fallback required.",
      metadata: {
        errors: outcome.intakeProtocolErrors,
      },
      ts: now,
    });
  }

  if (call.slaDeadlineAt) {
    await appendAuditEvent(storePath, {
      idempotencyKey: `audit:${call.callId}:sla:set`,
      callId: call.callId,
      caseId: call.caseId,
      type: "sla_deadline_set",
      message: "Set callback SLA deadline.",
      metadata: {
        slaDeadlineAt: call.slaDeadlineAt,
      },
      ts: now,
    });
  }

  const queuedChannels: DispatchChannel[] = [];
  const desiredChannels: DispatchChannel[] = ["dashboard", "email", "whatsapp"];

  for (const channel of desiredChannels) {
    if (!shouldQueueChannel(channel, outcome, admin)) {
      continue;
    }

    const entry = makeOutboxEntry({
      outcome,
      call,
      channel,
      admin,
      now,
    });

    state.outbox.push(entry);
    queuedChannels.push(channel);

    await appendAuditEvent(storePath, {
      idempotencyKey: `audit:${call.callId}:queue:${channel}`,
      callId: call.callId,
      caseId: call.caseId,
      type: "queue_enqueued",
      channel,
      message: `Enqueued ${channel} side effect in outbox.`,
      metadata: {
        outboxId: entry.id,
      },
      ts: now,
    });
  }

  await transitionCallStateWithAudit({
    storePath,
    state,
    callId: call.callId,
    caseId: call.caseId,
    stepKey: "queue_enqueued",
    nextState: "queued",
    now,
    reason: `queued_channels:${queuedChannels.join(",") || "none"}`,
  });

  state.updatedAt = now;
  await writePipelineState(storePath, state);

  return {
    ingested: true,
    queuedChannels,
    callId: call.callId,
  };
}

export async function processDeterministicPipeline(
  storePath: string,
  now = Date.now(),
): Promise<{
  processed: number;
  sent: number;
  retriesScheduled: number;
  deadLettered: number;
}> {
  const state = await readPipelineState(storePath);
  const admin = await loadKanzleiAdminConfig(storePath);

  let processed = 0;
  let sent = 0;
  let retriesScheduled = 0;
  let deadLettered = 0;

  const candidates = state.outbox.filter(
    (entry) =>
      (entry.state === "queued" || entry.state === "retry_pending") && entry.nextAttemptAt <= now,
  );

  for (const entry of candidates) {
    const call = state.calls[entry.callId];
    if (!call) {
      continue;
    }

    await transitionCallStateWithAudit({
      storePath,
      state,
      callId: call.callId,
      caseId: call.caseId,
      stepKey: `dispatch_start:${entry.channel}:${entry.attempts + 1}`,
      nextState: "dispatching",
      now,
      reason: `dispatch_attempt:${entry.channel}`,
    });

    entry.attempts += 1;
    entry.lastAttemptAt = now;
    processed += 1;

    await appendAuditEvent(storePath, {
      idempotencyKey: `audit:${call.callId}:dispatch:attempt:${entry.channel}:${entry.attempts}`,
      callId: call.callId,
      caseId: call.caseId,
      type: "dispatch_attempt",
      channel: entry.channel,
      message: `Dispatch attempt ${entry.attempts} for ${entry.channel}.`,
      metadata: {
        outboxId: entry.id,
      },
      ts: now,
    });

    const result = await attemptDispatch({
      storePath,
      admin,
      call,
      entry,
      now,
    });

    if (result.ok) {
      entry.state = "sent";
      entry.sentAt = now;
      entry.lastError = undefined;
      sent += 1;
      await appendAuditEvent(storePath, {
        idempotencyKey: `audit:${call.callId}:dispatch:sent:${entry.channel}:${entry.attempts}`,
        callId: call.callId,
        caseId: call.caseId,
        type: "dispatch_sent",
        channel: entry.channel,
        message: `Dispatched ${entry.channel} side effect successfully.`,
        metadata: {
          outboxId: entry.id,
          attempts: entry.attempts,
        },
        ts: now,
      });
      continue;
    }

    entry.lastError = result.reason || "dispatch_failed";

    if (result.retryable && entry.attempts < entry.maxAttempts) {
      entry.state = "retry_pending";
      entry.nextAttemptAt = now + computeBackoffMs(admin.retryPolicy.baseRetryDelayMs, entry.attempts);
      retriesScheduled += 1;
      await transitionCallStateWithAudit({
        storePath,
        state,
        callId: call.callId,
        caseId: call.caseId,
        stepKey: `dispatch_retry:${entry.channel}:${entry.attempts}`,
        nextState: "retry_pending",
        now,
        reason: entry.lastError || "retryable_dispatch_failure",
      });
      await appendAuditEvent(storePath, {
        idempotencyKey: `audit:${call.callId}:dispatch:retry:${entry.channel}:${entry.attempts}`,
        callId: call.callId,
        caseId: call.caseId,
        type: "dispatch_retry_scheduled",
        channel: entry.channel,
        message: `Scheduled retry for ${entry.channel} side effect.`,
        metadata: {
          outboxId: entry.id,
          nextAttemptAt: entry.nextAttemptAt,
          reason: entry.lastError,
        },
        ts: now,
      });
      continue;
    }

    entry.state = "dead_letter";
    entry.nextAttemptAt = Number.POSITIVE_INFINITY;
    deadLettered += 1;
    state.deadLetters.push({
      id: `${entry.id}:dead:${entry.attempts}`,
      callId: entry.callId,
      caseId: entry.caseId,
      channel: entry.channel,
      attempts: entry.attempts,
      reason: entry.lastError || "dead_letter",
      lastAttemptAt: now,
      payload: entry.payload,
    });
    await transitionCallStateWithAudit({
      storePath,
      state,
      callId: call.callId,
      caseId: call.caseId,
      stepKey: `dispatch_dead:${entry.channel}:${entry.attempts}`,
      nextState: "dead_letter",
      now,
      reason: entry.lastError || "non_retryable_dispatch_failure",
    });
    await appendAuditEvent(storePath, {
      idempotencyKey: `audit:${call.callId}:dispatch:dead:${entry.channel}:${entry.attempts}`,
      callId: call.callId,
      caseId: call.caseId,
      type: "dispatch_dead_lettered",
      channel: entry.channel,
      message: `Moved ${entry.channel} side effect to dead-letter queue.`,
      metadata: {
        outboxId: entry.id,
        reason: entry.lastError,
      },
      ts: now,
    });
  }

  // Reconcile call-level state after outbox processing.
  for (const call of Object.values(state.calls)) {
    const outboxForCall = state.outbox.filter((entry) => entry.callId === call.callId);
    if (outboxForCall.length === 0) {
      continue;
    }

    const allSent = outboxForCall.every((entry) => entry.state === "sent");
    const hasDead = outboxForCall.some((entry) => entry.state === "dead_letter");
    const hasRetry = outboxForCall.some((entry) => entry.state === "retry_pending");

    if (allSent) {
      await transitionCallStateWithAudit({
        storePath,
        state,
        callId: call.callId,
        caseId: call.caseId,
        stepKey: "reconcile_dispatched",
        nextState: "dispatched",
        now,
        reason: "all_outbox_entries_sent",
      });
    } else if (hasDead) {
      await transitionCallStateWithAudit({
        storePath,
        state,
        callId: call.callId,
        caseId: call.caseId,
        stepKey: "reconcile_dead_letter",
        nextState: "dead_letter",
        now,
        reason: "dead_letter_entry_present",
      });
    } else if (hasRetry) {
      await transitionCallStateWithAudit({
        storePath,
        state,
        callId: call.callId,
        caseId: call.caseId,
        stepKey: "reconcile_retry_pending",
        nextState: "retry_pending",
        now,
        reason: "retry_pending_entry_present",
      });
    }

    if (!call.slaBreached && call.slaDeadlineAt && now > call.slaDeadlineAt) {
      call.slaBreached = true;
      const stepKey = `call:${call.callId}:sla_breached`;
      if (!isStepAlreadyProcessed(state, stepKey)) {
        markStepProcessed(state, stepKey);
        await appendAuditEvent(storePath, {
          idempotencyKey: `audit:${call.callId}:sla:breached`,
          callId: call.callId,
          caseId: call.caseId,
          type: "sla_breached",
          message: "Call exceeded callback SLA deadline.",
          metadata: {
            slaDeadlineAt: call.slaDeadlineAt,
          },
          ts: now,
        });
      }
    }
  }

  state.updatedAt = now;
  await writePipelineState(storePath, state);

  return {
    processed,
    sent,
    retriesScheduled,
    deadLettered,
  };
}

export async function getKanzleiPipelineSnapshot(
  storePath: string,
  options?: {
    callLimit?: number;
    outboxLimit?: number;
    deadLetterLimit?: number;
    auditLimit?: number;
  },
): Promise<KanzleiPipelineSnapshot> {
  const now = Date.now();
  const state = await readPipelineState(storePath);
  const adminConfig = await loadKanzleiAdminConfig(storePath);

  const callLimit = Math.max(1, options?.callLimit ?? 50);
  const outboxLimit = Math.max(1, options?.outboxLimit ?? 100);
  const deadLetterLimit = Math.max(1, options?.deadLetterLimit ?? 50);
  const auditLimit = Math.max(1, options?.auditLimit ?? 100);

  const calls = Object.values(state.calls)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, callLimit);

  const outbox = [...state.outbox]
    .sort((a, b) => {
      const aTime = a.sentAt ?? a.lastAttemptAt ?? a.nextAttemptAt;
      const bTime = b.sentAt ?? b.lastAttemptAt ?? b.nextAttemptAt;
      return bTime - aTime;
    })
    .slice(0, outboxLimit);

  const deadLetters = [...state.deadLetters]
    .sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)
    .slice(0, deadLetterLimit);

  const recentAudit = await readAuditTail(storePath, auditLimit);

  const byOutboxState = countByState(state.outbox);

  return {
    contractVersion: "kanzlei_pipeline_snapshot_v1",
    generatedAt: now,
    summary: {
      totalCalls: Object.keys(state.calls).length,
      validatedCalls: Object.values(state.calls).filter((call) => call.intakeProtocolValid).length,
      invalidPayloadCalls: Object.values(state.calls).filter((call) => !call.intakeProtocolValid)
        .length,
      queuedOutbox: byOutboxState.queuedOutbox,
      retryPendingOutbox: byOutboxState.retryPendingOutbox,
      deadLetterOutbox: byOutboxState.deadLetterOutbox,
      sentOutbox: byOutboxState.sentOutbox,
      slaBreaches: Object.values(state.calls).filter((call) => call.slaBreached).length,
    },
    calls,
    outbox,
    deadLetters,
    recentAudit,
    adminConfig,
  };
}

export async function resetKanzleiPipelineState(storePath: string): Promise<void> {
  await writePipelineState(storePath, createDefaultState());
  await fs.rm(auditPath(storePath), { force: true });
  await fs.rm(dbPath(storePath), { force: true });
}

export async function summarizeKanzleiPipelineState(storePath: string): Promise<Record<string, unknown>> {
  const snapshot = await getKanzleiPipelineSnapshot(storePath, {
    callLimit: 20,
    outboxLimit: 50,
    deadLetterLimit: 20,
    auditLimit: 20,
  });
  return {
    contractVersion: snapshot.contractVersion,
    generatedAt: snapshot.generatedAt,
    summary: snapshot.summary,
    recentCalls: snapshot.calls,
    outbox: snapshot.outbox,
    deadLetters: snapshot.deadLetters,
  };
}
