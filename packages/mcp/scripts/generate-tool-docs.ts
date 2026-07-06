#!/usr/bin/env bun
// Generates the tool reference table embedded in packages/mcp/README.md.
//
// Approach: runtime import, no live server needed. Each register*Tools function
// only touches its `client` argument inside tool handler closures, never at
// registration time, so we call them with a stub client and a stub server that
// records the name + title + description passed to registerTool. This keeps the
// docs in lockstep with the actual registrations (single source of truth) rather
// than re-parsing source with brittle regexes.
//
// Run: bun run scripts/generate-tool-docs.ts        (rewrites README section)
//      bun run scripts/generate-tool-docs.ts --check (fails if README is stale)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerCleanupTools } from "../src/tools/cleanup";
import type { ToolContext } from "../src/tools/context";
import { registerCredentialTools } from "../src/tools/credentials";
import { registerEnvTools } from "../src/tools/env";
import { registerExecTools } from "../src/tools/exec";
import { registerProjectTools } from "../src/tools/projects";
import { registerRunTools } from "../src/tools/runs";
import { registerServerTools } from "../src/tools/server";
import { registerUpdateTools } from "../src/tools/update";

type CapturedTool = { name: string; title: string; description: string };

// Minimal stand-in for McpServer: records each registration. The register
// functions type their first arg as McpServer, so we cast at the call site.
function makeCaptureServer(sink: CapturedTool[]) {
  return {
    registerTool(name: string, config: { title?: string; description?: string }): void {
      sink.push({
        name,
        title: config.title ?? "",
        description: (config.description ?? "").replace(/\s+/g, " ").trim(),
      });
    },
  };
}

// The register functions never call into the client during registration, so an
// empty stub is enough to collect metadata.
const stubClient = {} as ToolContext;

// Ordered so the table reads deploy-first, matching the recommended workflow.
const domains: { name: string; register: (s: unknown, c: ToolContext) => void }[] = [
  { name: "Projects", register: registerProjectTools },
  { name: "Deployments & runs", register: registerRunTools },
  { name: "Exec & terminal", register: registerExecTools },
  { name: "Environment, cron, volumes & files", register: registerEnvTools },
  { name: "Credentials & DNS", register: registerCredentialTools },
  { name: "Server & observability", register: registerServerTools },
  { name: "Self-update", register: registerUpdateTools },
  { name: "Cleanup", register: registerCleanupTools },
];

const sections: { domain: string; tools: CapturedTool[] }[] = [];
let total = 0;
for (const { name, register } of domains) {
  const tools: CapturedTool[] = [];
  register(makeCaptureServer(tools) as never, stubClient);
  sections.push({ domain: name, tools });
  total += tools.length;
}

function renderMarkdown(): string {
  const lines: string[] = [];
  lines.push(
    `The server registers ${total} tools. Regenerate this section with \`bun run docs\` after changing any tool.`,
  );
  lines.push("");
  for (const { domain, tools } of sections) {
    lines.push(`### ${domain}`);
    lines.push("");
    lines.push("| Tool | Title | Description |");
    lines.push("| --- | --- | --- |");
    for (const t of tools) {
      const desc = t.description.replace(/\|/g, "\\|");
      const title = t.title.replace(/\|/g, "\\|");
      lines.push(`| \`${t.name}\` | ${title} | ${desc} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

const BEGIN = "<!-- BEGIN generated-tools (bun run docs) -->";
const END = "<!-- END generated-tools -->";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const readmePath = join(scriptDir, "..", "README.md");
const readme = readFileSync(readmePath, "utf8");

const beginIdx = readme.indexOf(BEGIN);
const endIdx = readme.indexOf(END);
if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
  console.error(`Could not find generated-section markers in ${readmePath}.`);
  console.error(`Add these markers where the table should live:\n${BEGIN}\n${END}`);
  process.exit(1);
}

const before = readme.slice(0, beginIdx + BEGIN.length);
const after = readme.slice(endIdx);
const next = `${before}\n${renderMarkdown()}\n\n${after}`;

if (process.argv.includes("--check")) {
  if (next !== readme) {
    console.error("README tool table is stale. Run `bun run docs` and commit.");
    process.exit(1);
  }
  console.log(`README tool table is up to date (${total} tools).`);
} else {
  writeFileSync(readmePath, next);
  console.log(`Wrote ${total} tools across ${sections.length} domains to README.md.`);
}
