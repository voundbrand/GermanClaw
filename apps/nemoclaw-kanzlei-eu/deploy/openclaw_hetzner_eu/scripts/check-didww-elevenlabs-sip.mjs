#!/usr/bin/env node

/**
 * Isolated DIDWW <-> ElevenLabs SIP readiness probe.
 *
 * This script is intentionally app-local (Kanzlei Hetzner deployment lane)
 * and must not call or depend on shared platform control-plane surfaces.
 */

import process from "node:process";

const DEFAULT_DIDWW_BASE_URL = "https://api.didww.com/v3";
const DEFAULT_ELEVENLABS_SIP_HOST = "sip.rtc.elevenlabs.io";
const DEFAULT_DIDWW_ALLOWED_HOSTS = ["api.didww.com"];

function usage() {
  console.log(`Usage:
  check-didww-elevenlabs-sip.mjs [--base-url <url>] [--api-key <key>] [--inbound-id <id>] [--outbound-id <id>] [--elevenlabs-sip-host <host>] [--allow-nonstandard-base-url] [--json]

Environment:
  DIDWW_API_KEY                 Required if --api-key is not set
  DIDWW_BASE_URL                Optional (default: ${DEFAULT_DIDWW_BASE_URL})
  ELEVENLABS_SIP_HOST           Optional (default: ${DEFAULT_ELEVENLABS_SIP_HOST})
`);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = "true";
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBaseUrl(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return DEFAULT_DIDWW_BASE_URL;
  }
  return normalized.replace(/\/+$/, "");
}

function parseUrlHost(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function pickStringField(record, keys) {
  for (const key of keys) {
    const value = normalizeOptionalString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function extractSipHostFromVoiceInTrunk(trunk) {
  const attributes = asRecord(trunk.attributes);
  const configuration = asRecord(attributes.configuration);
  const configurationAttributes = asRecord(configuration.attributes);
  return (
    pickStringField(configurationAttributes, ["host", "domain", "server"])
    || pickStringField(attributes, ["host", "domain", "server"])
  );
}

function extractVoiceInTrunkSummary(trunk) {
  const attributes = asRecord(trunk.attributes);
  const configuration = asRecord(attributes.configuration);
  return {
    id: pickStringField(trunk, ["id"]),
    name: pickStringField(attributes, ["name"]),
    configurationType: pickStringField(configuration, ["type"]),
    sipHost: extractSipHostFromVoiceInTrunk(trunk),
    createdAt: pickStringField(attributes, ["created_at"]),
  };
}

function extractVoiceOutTrunkSummary(trunk) {
  const attributes = asRecord(trunk.attributes);
  return {
    id: pickStringField(trunk, ["id"]),
    name: pickStringField(attributes, ["name"]),
    createdAt: pickStringField(attributes, ["created_at"]),
  };
}

function getDataArray(payload) {
  const record = asRecord(payload);
  return Array.isArray(record.data) ? record.data : [];
}

async function didwwGetJson(args) {
  const url = `${args.baseUrl}${args.path}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      "Api-Key": args.apiKey,
    },
  });

  const bodyText = await response.text();
  let parsedBody = null;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    parsedBody = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url,
    bodyText,
    parsedBody,
  };
}

function resolveTargetById(entries, id) {
  if (!id) {
    return null;
  }
  return entries.find((entry) => entry.id === id) || null;
}

function printHumanSummary(summary) {
  console.log("DIDWW <-> ElevenLabs SIP readiness");
  console.log("-----------------------------------");
  console.log(`Checked at: ${summary.checkedAtUtc}`);
  console.log(`DIDWW API: ${summary.didww.baseUrl}`);
  console.log(`ElevenLabs SIP host target: ${summary.elevenLabsSipHost}`);
  console.log("");
  console.log("Inbound trunks:");
  console.log(`- total: ${summary.didww.voiceIn.total}`);
  if (summary.didww.voiceIn.selected) {
    console.log(`- selected: ${summary.didww.voiceIn.selected.id} (${summary.didww.voiceIn.selected.name || "unnamed"})`);
    console.log(`- selected SIP host: ${summary.didww.voiceIn.selected.sipHost || "unknown"}`);
  } else {
    console.log("- selected: none");
  }
  console.log("");
  console.log("Outbound trunks:");
  console.log(`- total: ${summary.didww.voiceOut.total}`);
  if (summary.didww.voiceOut.selected) {
    console.log(`- selected: ${summary.didww.voiceOut.selected.id} (${summary.didww.voiceOut.selected.name || "unnamed"})`);
  } else {
    console.log("- selected: none");
  }
  console.log("");
  console.log("Readiness:");
  for (const check of summary.readiness.checks) {
    console.log(`- ${check.key}: ${check.pass ? "PASS" : "FAIL"}${check.reason ? ` (${check.reason})` : ""}`);
  }
  console.log(`- overall: ${summary.readiness.overall ? "READY" : "NOT_READY"}`);
  console.log("");
  console.log("Next manual steps:");
  for (const step of summary.nextSteps) {
    console.log(`- ${step}`);
  }
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help === "true" || flags.h === "true") {
    usage();
    return;
  }

  const apiKey = normalizeOptionalString(flags["api-key"]) || normalizeOptionalString(process.env.DIDWW_API_KEY);
  const baseUrl = normalizeBaseUrl(flags["base-url"] || process.env.DIDWW_BASE_URL);
  const inboundId = normalizeOptionalString(flags["inbound-id"]);
  const outboundId = normalizeOptionalString(flags["outbound-id"]);
  const elevenLabsSipHost =
    normalizeOptionalString(flags["elevenlabs-sip-host"])
    || normalizeOptionalString(process.env.ELEVENLABS_SIP_HOST)
    || DEFAULT_ELEVENLABS_SIP_HOST;
  const emitJson = flags.json === "true";
  const allowNonstandardBaseUrl = flags["allow-nonstandard-base-url"] === "true";

  if (!apiKey) {
    fail("Missing DIDWW API key. Provide --api-key or DIDWW_API_KEY.");
  }

  const baseUrlHost = parseUrlHost(baseUrl);
  if (!baseUrlHost) {
    fail(`Invalid DIDWW base URL: '${baseUrl}'.`);
  }
  if (!allowNonstandardBaseUrl && !DEFAULT_DIDWW_ALLOWED_HOSTS.includes(baseUrlHost)) {
    fail(
      `DIDWW base URL host '${baseUrlHost}' is not in the protected-track allowlist (${DEFAULT_DIDWW_ALLOWED_HOSTS.join(", ")}).` +
      " Pass --allow-nonstandard-base-url only for explicit local/mock testing.",
    );
  }

  const [voiceInResponse, voiceOutResponse] = await Promise.all([
    didwwGetJson({
      baseUrl,
      apiKey,
      path: "/voice_in_trunks?page[size]=100",
    }),
    didwwGetJson({
      baseUrl,
      apiKey,
      path: "/voice_out_trunks?page[size]=100",
    }),
  ]);

  if (!voiceInResponse.ok) {
    fail(
      `DIDWW voice_in_trunks request failed (${voiceInResponse.status} ${voiceInResponse.statusText}).` +
      ` URL: ${voiceInResponse.url}`,
    );
  }
  if (!voiceOutResponse.ok) {
    fail(
      `DIDWW voice_out_trunks request failed (${voiceOutResponse.status} ${voiceOutResponse.statusText}).` +
      ` URL: ${voiceOutResponse.url}`,
    );
  }

  const voiceInTrunks = getDataArray(voiceInResponse.parsedBody).map(extractVoiceInTrunkSummary);
  const voiceOutTrunks = getDataArray(voiceOutResponse.parsedBody).map(extractVoiceOutTrunkSummary);

  const selectedInbound =
    resolveTargetById(voiceInTrunks, inboundId)
    || voiceInTrunks.find((trunk) => normalizeOptionalString(trunk.sipHost) !== null)
    || voiceInTrunks[0]
    || null;
  const selectedOutbound =
    resolveTargetById(voiceOutTrunks, outboundId)
    || voiceOutTrunks[0]
    || null;

  const inboundSipHost = normalizeOptionalString(selectedInbound?.sipHost);
  const inboundLooksElevenLabs =
    !!inboundSipHost && inboundSipHost.toLowerCase() === elevenLabsSipHost.toLowerCase();

  const checks = [
    {
      key: "has_voice_in_trunk",
      pass: voiceInTrunks.length > 0,
      reason: voiceInTrunks.length > 0 ? null : "No inbound DIDWW SIP trunk exists.",
    },
    {
      key: "has_voice_out_trunk",
      pass: voiceOutTrunks.length > 0,
      reason: voiceOutTrunks.length > 0 ? null : "No outbound DIDWW trunk exists.",
    },
    {
      key: "inbound_points_to_elevenlabs",
      pass: inboundLooksElevenLabs,
      reason:
        inboundLooksElevenLabs
          ? null
          : inboundSipHost
            ? `Inbound SIP host is '${inboundSipHost}', expected '${elevenLabsSipHost}'.`
            : "Inbound SIP host is missing on selected trunk.",
    },
  ];

  const summary = {
    checkedAtUtc: new Date().toISOString(),
    isolationBoundary: {
      scope: "apps/nemoclaw-kanzlei-eu",
      sharedPlatformCalls: false,
      didwwBaseUrlHost: baseUrlHost,
      didwwBaseUrlAllowedHosts: DEFAULT_DIDWW_ALLOWED_HOSTS,
      nonstandardBaseUrlOverride: allowNonstandardBaseUrl,
    },
    didww: {
      baseUrl,
      voiceIn: {
        total: voiceInTrunks.length,
        selected: selectedInbound,
        trunks: voiceInTrunks,
      },
      voiceOut: {
        total: voiceOutTrunks.length,
        selected: selectedOutbound,
        trunks: voiceOutTrunks,
      },
    },
    elevenLabsSipHost,
    readiness: {
      checks,
      overall: checks.every((entry) => entry.pass),
    },
    nextSteps: [
      "In DIDWW User Panel, ensure selected inbound trunk routes to ElevenLabs SIP host and is assigned to DID numbers.",
      "In ElevenLabs, import the DIDWW number from SIP trunk and attach the target voice agent.",
      "If outbound calling is needed, verify DIDWW outbound trunk credentials and ElevenLabs outbound SIP settings.",
      "Run a consented real PSTN test call and attach evidence to Kanzlei hardening docs.",
    ],
  };

  if (emitJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printHumanSummary(summary);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
