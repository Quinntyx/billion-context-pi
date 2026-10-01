import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { acpJsonFiles, userConfigPath } from "../src/config-dir.js";
import { loadUserConfig } from "../src/user-config.js";

const CWD = path.resolve("/project");
const PROJECT = userConfigPath(CWD, "acp.json");

for (const env of [{}, { PI_CODING_AGENT_DIR: "" }]) {
  test(`acpJsonFiles preserves legacy paths for ${JSON.stringify(env)}`, () => {
    assert.deepEqual(acpJsonFiles(CWD, env), [userConfigPath(homedir(), "acp.json"), PROJECT]);
  });
}

for (const agentDir of ["/srv/pi/profiles/main", "/srv/pi/profiles/subagents", "profiles/main", "~", "~/profiles/main"]) {
  test(`acpJsonFiles honors PI_CODING_AGENT_DIR=${agentDir}`, () => {
    const expanded = agentDir === "~" ? homedir()
      : agentDir.startsWith("~/") ? path.join(homedir(), agentDir.slice(2))
      : agentDir;
    assert.deepEqual(acpJsonFiles(CWD, { PI_CODING_AGENT_DIR: agentDir }), [path.join(expanded, "acp.json"), PROJECT]);
  });
}

test("acpJsonFiles reads the environment on each call", (t) => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  });
  process.env.PI_CODING_AGENT_DIR = "/srv/pi/main";
  assert.equal(acpJsonFiles(CWD)[0], path.join("/srv/pi/main", "acp.json"));
  process.env.PI_CODING_AGENT_DIR = "/srv/pi/subagents";
  assert.equal(acpJsonFiles(CWD)[0], path.join("/srv/pi/subagents", "acp.json"));
});

test("loadUserConfig isolates profiles and retains project per-field overrides", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "bcp-profile-config-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const cwd = path.join(root, "project");
  const main = path.join(root, "profiles", "main");
  const subagents = path.join(root, "profiles", "subagents");
  for (const [file, config] of [
    [userConfigPath(root, "acp.json"), { debug: true, modelContextLimit: 999999 }],
    [path.join(main, "acp.json"), { delegate: false, modelContextLimit: 100000 }],
    [path.join(subagents, "acp.json"), { delegate: true, modelContextLimit: 50000 }],
    [userConfigPath(cwd, "acp.json"), { debug: false }],
  ] as const) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(config));
  }
  process.env.PI_CODING_AGENT_DIR = main;
  assert.deepEqual(await loadUserConfig(cwd), { delegate: false, modelContextLimit: 100000, debug: false });
  process.env.PI_CODING_AGENT_DIR = subagents;
  assert.deepEqual(await loadUserConfig(cwd), { delegate: true, modelContextLimit: 50000, debug: false });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "missing-profile");
  assert.deepEqual(await loadUserConfig(cwd), { debug: false }, "missing profile must not leak legacy global settings");
  delete process.env.PI_CODING_AGENT_DIR;
  assert.deepEqual(await loadUserConfig(cwd), { debug: false, modelContextLimit: 999999 });
});
