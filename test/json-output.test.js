// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

function run(args, home) {
  try {
    const out = execSync(`${JSON.stringify(process.execPath)} "${CLI}" ${args}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, HOME: home },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: (err.stdout || "") + (err.stderr || "") };
  }
}

describe("--json output", () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-json-test-"));
    const nemoclawDir = path.join(tmpHome, ".nemoclaw");
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "my-assistant",
        sandboxes: {
          "my-assistant": {
            name: "my-assistant",
            createdAt: "2026-03-25T00:00:00.000Z",
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: ["pypi", "npm-registry"],
          },
        },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("list --json outputs valid JSON with sandbox array", () => {
    const r = run("list --json", tmpHome);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out);
    expect(data.sandboxes).toBeInstanceOf(Array);
    expect(data.sandboxes).toHaveLength(1);
    expect(data.sandboxes[0]).toMatchObject({
      name: "my-assistant",
      default: true,
      model: "nvidia/nemotron-3-super-120b-a12b",
      provider: "nvidia-prod",
      gpuEnabled: false,
      policies: ["pypi", "npm-registry"],
    });
  });

  it("list --json outputs empty array when no sandboxes", () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-json-empty-"));
    const r = run("list --json", emptyHome);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out);
    expect(data.sandboxes).toEqual([]);
    fs.rmSync(emptyHome, { recursive: true, force: true });
  });

  it("status --json outputs valid JSON with sandbox array", () => {
    const r = run("status --json", tmpHome);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out);
    expect(data.sandboxes).toBeInstanceOf(Array);
    expect(data.sandboxes[0].name).toBe("my-assistant");
    expect(data.sandboxes[0].default).toBe(true);
  });
});
