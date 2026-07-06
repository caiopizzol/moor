import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolContext } from "./context";
export function registerCredentialTools(server: McpServer, client: ToolContext): void {
  const { apiResponse, readErrorMessage } = client;

  server.registerTool(
    "moor_dns_check",
    {
      title: "Check Domain DNS",
      description:
        "Resolves a domain's A record and reports whether it matches the server's public IP. Useful before pointing a project's domain at the server.",
      inputSchema: z.object({
        domain: z.string().min(1).describe("Domain to check, e.g. app.example.com"),
      }),
    },
    async ({ domain }) => {
      const res = await apiResponse.post("/api/dns-check", { domain });
      if (!res.ok) throw new Error(`Failed: ${await readErrorMessage(res)}`);
      const data = (await res.json()) as {
        resolves: boolean;
        ip: string | null;
        serverIp: string | null;
      };
      const lines = [
        `Domain: ${domain}`,
        `Resolves: ${data.resolves ? "yes" : "no"}`,
        `Resolved IP: ${data.ip ?? "(none)"}`,
        `Server IP: ${data.serverIp ?? "(unknown)"}`,
      ];
      if (data.ip && data.serverIp) {
        lines.push(`Match: ${data.ip === data.serverIp ? "yes" : "no"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  type RegistryCredentialMetadata = {
    id: number;
    hostname: string;
    username: string;
    secret: {
      configured: true;
      kind: "github_classic_pat" | "github_fine_grained_pat" | "unknown";
    };
    created_at: string;
    updated_at: string;
  };

  function renderCredentialLine(c: RegistryCredentialMetadata): string {
    return `id=${c.id} ${c.hostname} user=${c.username} kind=${c.secret.kind} updated=${c.updated_at}`;
  }

  server.registerTool(
    "moor_registry_credentials_list",
    {
      title: "List Registry Credentials",
      description:
        "List all stored Docker registry credentials. Returns metadata only - the raw secret value is never returned by any read path. Each row carries `secret: { configured: true, kind }` where kind is derived from known token prefixes (github_classic_pat, github_fine_grained_pat) or 'unknown'.",
    },
    async () => {
      const res = await apiResponse.get("/api/server/registry-credentials");
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const data = (await res.json()) as { rows: RegistryCredentialMetadata[] };
      const text =
        data.rows.length === 0
          ? "No registry credentials configured. The pull path falls back to anonymous for every registry."
          : data.rows.map(renderCredentialLine).join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { rows: data.rows },
      };
    },
  );

  server.registerTool(
    "moor_registry_credential_get",
    {
      title: "Get Registry Credential",
      description:
        "Get a single stored registry credential by id. Returns metadata only - the raw secret is never returned. Use this before moor_registry_credential_delete to confirm the hostname you intend to delete.",
      inputSchema: z.object({
        id: z
          .number()
          .int()
          .positive()
          .describe("Credential id (from moor_registry_credentials_list)"),
      }),
    },
    async ({ id }) => {
      const res = await apiResponse.get(`/api/server/registry-credentials/${id}`);
      if (res.status === 404) throw new Error(`credential id=${id} not found`);
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const row = (await res.json()) as RegistryCredentialMetadata;
      return {
        content: [{ type: "text", text: renderCredentialLine(row) }],
        structuredContent: row as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "moor_registry_credential_add",
    {
      title: "Add Registry Credential",
      description:
        "Store a credential for a Docker registry. The pull path will attach X-Registry-Auth to /images/create whenever an image ref matches this hostname. Hostname must be the bare host as it appears in the image ref (e.g. ghcr.io, docker.io, localhost:5000) - no scheme, no path. Note: the secret value passes through the MCP client and tool-call transport, same security model as moor_env_set; rotate via moor_registry_credential_update if it has been exposed.",
      inputSchema: z.object({
        hostname: z
          .string()
          .describe(
            "Bare registry host as parsed from an image ref. Examples: ghcr.io, docker.io, localhost:5000, registry.example.com:5000. No scheme, no path.",
          ),
        username: z
          .string()
          .describe("Registry username. For GHCR with a classic PAT, use your GitHub username."),
        secret: z
          .string()
          .describe(
            "Registry password or token. For GHCR, a classic PAT with read:packages is the documented path. Visible to the MCP client on input.",
          ),
      }),
    },
    async ({ hostname, username, secret }) => {
      const res = await apiResponse.post("/api/server/registry-credentials", {
        hostname,
        username,
        secret,
      });
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const row = (await res.json()) as RegistryCredentialMetadata;
      return {
        content: [
          {
            type: "text",
            text: `Added credential for ${row.hostname} (id=${row.id}, kind=${row.secret.kind}).`,
          },
        ],
        structuredContent: row as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "moor_registry_credential_update",
    {
      title: "Update Registry Credential",
      description:
        "Rotate username and/or secret on an existing credential. Hostname is intentionally not patchable - changing the lookup key on an existing row would silently break the pull path. To change hostnames, delete and re-create. Requires at least one of username or secret. Note: the secret value passes through the MCP client on input - same security model as moor_env_set.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Credential id to update"),
        username: z.string().optional().describe("New username (optional)"),
        secret: z
          .string()
          .optional()
          .describe("New secret (optional). Visible to the MCP client on input."),
      }),
    },
    async ({ id, username, secret }) => {
      if (username === undefined && secret === undefined) {
        throw new Error("must provide at least one of username or secret to update");
      }
      const patch: Record<string, string> = {};
      if (username !== undefined) patch.username = username;
      if (secret !== undefined) patch.secret = secret;
      const res = await apiResponse.put(`/api/server/registry-credentials/${id}`, patch);
      if (res.status === 404) throw new Error(`credential id=${id} not found`);
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const row = (await res.json()) as RegistryCredentialMetadata;
      const rotated: string[] = [];
      if (username !== undefined) rotated.push("username");
      if (secret !== undefined) rotated.push("secret");
      return {
        content: [
          {
            type: "text",
            text: `Updated credential id=${id} (${row.hostname}): rotated ${rotated.join(" + ")}. kind=${row.secret.kind}.`,
          },
        ],
        structuredContent: row as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "moor_registry_credential_delete",
    {
      title: "Delete Registry Credential",
      description:
        "Delete a stored registry credential. Requires confirm_hostname to match the resolved row's hostname exactly - guards against deleting the wrong row from a stale id. After deletion, pulls for that registry fall back to anonymous. Irreversible.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Credential id to delete"),
        confirm_hostname: z
          .string()
          .describe(
            "Must equal the credential row's hostname exactly. Resolved via moor_registry_credential_get and compared before deletion.",
          ),
      }),
    },
    async ({ id, confirm_hostname }) => {
      const getRes = await apiResponse.get(`/api/server/registry-credentials/${id}`);
      if (getRes.status === 404) throw new Error(`credential id=${id} not found`);
      if (!getRes.ok)
        throw new Error(
          `Failed to fetch credential: ${getRes.status} ${await readErrorMessage(getRes)}`,
        );
      const row = (await getRes.json()) as RegistryCredentialMetadata;
      if (confirm_hostname !== row.hostname) {
        throw new Error(
          `confirm_hostname "${confirm_hostname}" does not match resolved hostname "${row.hostname}". Refusing to delete.`,
        );
      }
      const delRes = await apiResponse.delete(`/api/server/registry-credentials/${id}`);
      if (!delRes.ok)
        throw new Error(`Failed to delete: ${delRes.status} ${await readErrorMessage(delRes)}`);
      return {
        content: [{ type: "text", text: `Deleted credential for ${row.hostname} (id=${id}).` }],
        structuredContent: { deleted: { id, hostname: row.hostname } },
      };
    },
  );

  type SourceCredentialMetadata = {
    id: number;
    hostname: string;
    label: string;
    username: string;
    secret: {
      configured: true;
      kind: "github_classic_pat" | "github_fine_grained_pat" | "unknown";
    };
    state: "active" | "failed";
    expires_at: string | null;
    last_checked_at: string | null;
    last_check_status: string | null;
    created_at: string;
    updated_at: string;
  };

  function renderSourceCredentialLine(c: SourceCredentialMetadata): string {
    const checked = c.last_check_status ? ` last_check=${c.last_check_status}` : "";
    return `id=${c.id} ${c.hostname} label=${c.label} user=${c.username} kind=${c.secret.kind} state=${c.state}${checked}`;
  }

  server.registerTool(
    "moor_source_credentials_list",
    {
      title: "List Source Credentials",
      description:
        "List all stored Git source credentials (HTTPS PATs). Returns metadata only - the raw secret value is never returned by any read path. Multiple credentials can share a hostname (e.g. two github.com rows for different orgs); use label to disambiguate.",
    },
    async () => {
      const res = await apiResponse.get("/api/server/source-credentials");
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const data = (await res.json()) as { rows: SourceCredentialMetadata[] };
      const text =
        data.rows.length === 0
          ? "No source credentials configured. Public repos work anonymously."
          : data.rows.map(renderSourceCredentialLine).join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { rows: data.rows },
      };
    },
  );

  server.registerTool(
    "moor_source_credential_get",
    {
      title: "Get Source Credential",
      description:
        "Get a single source credential by id. Returns metadata only. Use this before moor_source_credential_delete to confirm the label you intend to delete.",
      inputSchema: z.object({
        id: z
          .number()
          .int()
          .positive()
          .describe("Credential id (from moor_source_credentials_list)"),
      }),
    },
    async ({ id }) => {
      const res = await apiResponse.get(`/api/server/source-credentials/${id}`);
      if (res.status === 404) throw new Error(`source credential id=${id} not found`);
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const row = (await res.json()) as SourceCredentialMetadata;
      return {
        content: [{ type: "text", text: renderSourceCredentialLine(row) }],
        structuredContent: row as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "moor_source_credential_add",
    {
      title: "Add Source Credential",
      description:
        "Store a Git source credential (HTTPS PAT) for a private repo host. v1 supports HTTPS PATs only; SSH deploy keys may be added in a future version. Hostname must be the bare host as parsed from a Git URL (github.com, gitlab.com, etc.) - no scheme, no path. Multiple credentials can share a hostname; the (hostname, label) pair is unique. For GitHub: use a fine-grained PAT with `Contents: read` (username `x-access-token`), or a classic PAT with `repo` scope. Note: the secret value passes through the MCP client and tool-call transport on input, same security model as moor_env_set.",
      inputSchema: z.object({
        hostname: z
          .string()
          .describe("Bare Git host: github.com, gitlab.com, etc. No scheme, no path."),
        label: z
          .string()
          .describe(
            "Operator-supplied label for disambiguation when multiple credentials share a host (e.g. 'personal', 'work-org', 'acme-clients'). Trimmed at storage.",
          ),
        username: z
          .string()
          .describe(
            "Git username. For GitHub fine-grained PATs, use 'x-access-token'. For classic PATs, your GitHub username works too.",
          ),
        secret: z
          .string()
          .describe(
            "Git token (PAT). Visible to the MCP client on input; rotate via moor_source_credential_update if exposed.",
          ),
        expires_at: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Operator-supplied expiry timestamp (PAT expiry from GitHub). Optional; helps rotation reminders.",
          ),
      }),
    },
    async ({ hostname, label, username, secret, expires_at }) => {
      const body: Record<string, unknown> = { hostname, label, username, secret };
      if (expires_at !== undefined) body.expires_at = expires_at;
      const res = await apiResponse.post("/api/server/source-credentials", body);
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const row = (await res.json()) as SourceCredentialMetadata;
      return {
        content: [
          {
            type: "text",
            text: `Added source credential for ${row.hostname} label="${row.label}" (id=${row.id}, kind=${row.secret.kind}).`,
          },
        ],
        structuredContent: row as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "moor_source_credential_update",
    {
      title: "Update Source Credential",
      description:
        "Rotate username, secret, label, or expires_at on an existing source credential. Hostname is intentionally not patchable - changing the lookup key on an existing row would silently break in-flight builds. To change hostname, delete and recreate. Requires at least one of username, secret, label, or expires_at.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Credential id to update"),
        username: z.string().optional().describe("New username (optional)"),
        secret: z
          .string()
          .optional()
          .describe("New secret (optional). Visible to the MCP client on input."),
        label: z.string().optional().describe("New label (optional). Trimmed at storage."),
        expires_at: z.string().nullable().optional().describe("New expiry; null to clear"),
      }),
    },
    async ({ id, username, secret, label, expires_at }) => {
      if (
        username === undefined &&
        secret === undefined &&
        label === undefined &&
        expires_at === undefined
      ) {
        throw new Error("must provide at least one of username, secret, label, or expires_at");
      }
      const patch: Record<string, unknown> = {};
      if (username !== undefined) patch.username = username;
      if (secret !== undefined) patch.secret = secret;
      if (label !== undefined) patch.label = label;
      if (expires_at !== undefined) patch.expires_at = expires_at;
      const res = await apiResponse.put(`/api/server/source-credentials/${id}`, patch);
      if (res.status === 404) throw new Error(`source credential id=${id} not found`);
      if (!res.ok) throw new Error(`Failed: ${res.status} ${await readErrorMessage(res)}`);
      const row = (await res.json()) as SourceCredentialMetadata;
      const fields: string[] = [];
      if (username !== undefined) fields.push("username");
      if (secret !== undefined) fields.push("secret");
      if (label !== undefined) fields.push("label");
      if (expires_at !== undefined) fields.push("expires_at");
      return {
        content: [
          {
            type: "text",
            text: `Updated source credential id=${id} (${row.hostname}, ${row.label}): rotated ${fields.join(" + ")}. kind=${row.secret.kind}.`,
          },
        ],
        structuredContent: row as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "moor_source_credential_delete",
    {
      title: "Delete Source Credential",
      description:
        "Delete a stored source credential. Requires confirm_label to match the resolved row's label exactly - protects against deleting the wrong credential on a host that has several (e.g. two github.com rows). Refused with credential_in_use if any project still references this credential. Irreversible.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Credential id to delete"),
        confirm_label: z
          .string()
          .describe(
            "Must equal the credential row's label exactly. Resolved via moor_source_credential_get and compared before deletion.",
          ),
      }),
    },
    async ({ id, confirm_label }) => {
      const getRes = await apiResponse.get(`/api/server/source-credentials/${id}`);
      if (getRes.status === 404) throw new Error(`source credential id=${id} not found`);
      if (!getRes.ok)
        throw new Error(
          `Failed to fetch credential: ${getRes.status} ${await readErrorMessage(getRes)}`,
        );
      const row = (await getRes.json()) as SourceCredentialMetadata;
      if (confirm_label !== row.label) {
        throw new Error(
          `confirm_label "${confirm_label}" does not match resolved label "${row.label}". Refusing to delete.`,
        );
      }
      const delRes = await apiResponse.delete(
        `/api/server/source-credentials/${id}?confirm_label=${encodeURIComponent(row.label)}`,
      );
      if (delRes.status === 409) {
        const body = (await delRes.json()) as { projects: string[] };
        throw new Error(
          `credential_in_use: ${body.projects.length} project(s) still reference id=${id}: ${body.projects.join(", ")}`,
        );
      }
      if (!delRes.ok)
        throw new Error(`Failed to delete: ${delRes.status} ${await readErrorMessage(delRes)}`);
      return {
        content: [
          {
            type: "text",
            text: `Deleted source credential ${row.hostname}/${row.label} (id=${id}).`,
          },
        ],
        structuredContent: { deleted: { id, hostname: row.hostname, label: row.label } },
      };
    },
  );

  server.registerTool(
    "moor_source_credential_check",
    {
      title: "Check Source Credential Access",
      description:
        "Run a real `git ls-remote` against the repo URL to verify access. Without source_credential_id, probes anonymously first; if private and exactly one credential matches the host, auto-selects it. With source_credential_id, tests that exact credential. With branch, tests the specific branch (branch_not_found is distinct from auth failure). Discovers default_branch via HEAD symref when no branch is provided. Side effect: updates last_checked_at and last_check_status on the credential row; flips state to failed on a credentialed rejection.",
      inputSchema: z.object({
        github_url: z
          .string()
          .describe(
            "HTTPS Git repo URL: https://host/owner/repo (optional .git). No query, no fragment, no embedded credentials.",
          ),
        branch: z
          .string()
          .optional()
          .describe("Specific branch to verify. Omit to discover the default branch."),
        source_credential_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Pin a specific credential. Required when multiple credentials match the host.",
          ),
      }),
    },
    async ({ github_url, branch, source_credential_id }) => {
      const body: Record<string, unknown> = { github_url };
      if (branch !== undefined) body.branch = branch;
      if (source_credential_id !== undefined) body.source_credential_id = source_credential_id;
      const res = await apiResponse.post("/api/server/source-credentials/check", body);
      const json = (await res.json()) as Record<string, unknown>;
      if (res.ok) {
        const def = json.default_branch ? ` default_branch=${json.default_branch}` : "";
        const head = json.head_sha ? ` head_sha=${String(json.head_sha).slice(0, 12)}` : "";
        const auto = json.auto_selected_credential_id
          ? ` auto_selected=${json.auto_selected_credential_id}`
          : "";
        return {
          content: [{ type: "text", text: `reachable${def}${head}${auto}` }],
          structuredContent: json,
        };
      }
      // Non-OK: surface the structured failure shape directly. The agent
      // can branch on `code` to decide what to do next (ask for a PAT,
      // pick from candidates, etc.).
      return {
        content: [
          {
            type: "text",
            text: `check failed: code=${json.code}${json.reason ? ` reason=${json.reason}` : ""}`,
          },
        ],
        structuredContent: json,
        isError: true,
      };
    },
  );
}
