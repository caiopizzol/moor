import { useEffect, useRef, useState } from "react";
import type { Project } from "../lib/api";
import { api } from "../lib/api";

type SourceType = "github" | "image";

type ProjectData = {
  name: string;
  github_url?: string | null;
  docker_image?: string | null;
  branch?: string;
  dockerfile?: string;
  domain?: string | null;
  domain_port?: number | null;
};

type Props = {
  project?: Project;
  onClose: () => void;
  onSave: (data: ProjectData) => Promise<void>;
};

type DnsStatus = {
  checking: boolean;
  resolves?: boolean;
  ip?: string | null;
  serverIp?: string | null;
};

export function ProjectModal({ project, onClose, onSave }: Props) {
  const isEdit = !!project;
  const nameRef = useRef<HTMLInputElement>(null);

  const initialSource: SourceType = project?.docker_image ? "image" : "github";
  const [source, setSource] = useState<SourceType>(initialSource);
  const [name, setName] = useState(project?.name ?? "");
  const [githubUrl, setGithubUrl] = useState(project?.github_url ?? "");
  const [branch, setBranch] = useState(project?.branch ?? "main");
  const [dockerfile, setDockerfile] = useState(
    project?.dockerfile && project.dockerfile !== "Dockerfile" ? project.dockerfile : "",
  );
  const [dockerImage, setDockerImage] = useState(project?.docker_image ?? "");
  const [domain, setDomain] = useState(project?.domain ?? "");
  const [domainPort, setDomainPort] = useState(project?.domain_port?.toString() ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dns, setDns] = useState<DnsStatus>({ checking: false });

  const dnsTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Debounced DNS check when domain changes
  useEffect(() => {
    if (dnsTimerRef.current) clearTimeout(dnsTimerRef.current);

    const trimmed = domain.trim();
    if (!trimmed) {
      setDns({ checking: false });
      return;
    }

    setDns({ checking: true });
    dnsTimerRef.current = setTimeout(async () => {
      try {
        const result = await api.dns.check(trimmed);
        setDns({ checking: false, ...result });
      } catch {
        setDns({ checking: false });
      }
    }, 600);

    return () => {
      if (dnsTimerRef.current) clearTimeout(dnsTimerRef.current);
    };
  }, [domain]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError("");
    setLoading(true);
    try {
      const domainValue = domain.trim() || null;
      const portValue = domainPort.trim() ? Number(domainPort) : null;

      if (source === "image") {
        await onSave({
          name: name.trim(),
          docker_image: dockerImage.trim() || undefined,
          github_url: null,
          domain: domainValue,
          domain_port: portValue,
        });
      } else {
        await onSave({
          name: name.trim(),
          github_url: githubUrl.trim() || undefined,
          docker_image: null,
          branch: branch.trim() || "main",
          dockerfile: dockerfile.trim() || "Dockerfile",
          domain: domainValue,
          domain_port: portValue,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  };

  const dnsMatch = !!(dns.resolves && dns.ip && dns.serverIp && dns.ip === dns.serverIp);
  const dnsMismatch = !!(dns.resolves && dns.ip && dns.serverIp && dns.ip !== dns.serverIp);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: overlay handles keyboard events
    <div
      className="modal-overlay"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3>{isEdit ? "Edit Project" : "New Project"}</h3>
        <div className="source-toggle">
          <button
            type="button"
            className={source === "github" ? "active" : ""}
            onClick={() => setSource("github")}
          >
            GitHub Repo
          </button>
          <button
            type="button"
            className={source === "image" ? "active" : ""}
            onClick={() => setSource("image")}
          >
            Docker Image
          </button>
        </div>
        <div className="field">
          <label>
            Name
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-service"
            />
          </label>
        </div>
        {source === "github" ? (
          <>
            <div className="field">
              <label>
                GitHub URL
                <input
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                  placeholder="https://github.com/user/repo"
                />
              </label>
            </div>
            <div className="field">
              <label>
                Branch
                <input value={branch} onChange={(e) => setBranch(e.target.value)} />
              </label>
            </div>
            <div className="field">
              <label>
                Dockerfile Path{" "}
                <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>
                  Defaults to ./Dockerfile
                </span>
                <input
                  value={dockerfile}
                  onChange={(e) => setDockerfile(e.target.value)}
                  placeholder="e.g. ./services/api/Dockerfile"
                />
              </label>
            </div>
          </>
        ) : (
          <div className="field">
            <label>
              Image
              <input
                value={dockerImage}
                onChange={(e) => setDockerImage(e.target.value)}
                placeholder="e.g. postgres:16, ghost:5, gitea/gitea:latest"
              />
            </label>
            <div style={{ fontSize: "0.8em", color: "var(--text-dim)", marginTop: 4 }}>
              Docker Hub image with optional tag
            </div>
          </div>
        )}

        {/* Routing section */}
        <div
          style={{
            height: 1,
            background: "var(--border)",
            margin: "18px 0",
          }}
        />
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--text-dim)",
            marginBottom: 14,
          }}
        >
          Routing
        </div>

        <div className="field">
          <label>
            Domain <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>(optional)</span>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="e.g. api.example.com"
              style={dnsMismatch ? { borderColor: "var(--red)" } : undefined}
            />
          </label>
          {domain.trim() && (
            <DnsIndicator dns={dns} dnsMatch={dnsMatch} dnsMismatch={dnsMismatch} />
          )}
          {!domain.trim() && (
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.4 }}>
              Point your DNS to this server's IP, then enter the domain here. Caddy will
              auto-provision a Let's Encrypt certificate.
            </div>
          )}
        </div>

        <div className="field">
          <label>
            Port{" "}
            <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>
              Container port to route traffic to
            </span>
            <input
              value={domainPort}
              onChange={(e) => setDomainPort(e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 3000"
              style={{ width: 120 }}
              disabled={!domain.trim()}
            />
          </label>
        </div>

        {error && <div style={{ color: "var(--red, #e55)", fontSize: "0.9em" }}>{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!name.trim() || loading || !!dnsMismatch}
          >
            {loading ? "Saving..." : dnsMismatch ? "DNS Mismatch" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DnsIndicator({
  dns,
  dnsMatch,
  dnsMismatch,
}: {
  dns: DnsStatus;
  dnsMatch: boolean;
  dnsMismatch: boolean;
}) {
  if (dns.checking) {
    return (
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginTop: 6,
          padding: "6px 10px",
          borderRadius: 4,
        }}
      >
        Checking DNS...
      </div>
    );
  }

  if (dnsMatch) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          marginTop: 6,
          padding: "6px 10px",
          borderRadius: 4,
          color: "var(--green)",
          background: "rgba(74, 222, 128, 0.08)",
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "currentColor",
          }}
        />
        DNS resolves to {dns.ip} — matches this server
      </div>
    );
  }

  if (dnsMismatch) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          marginTop: 6,
          padding: "6px 10px",
          borderRadius: 4,
          color: "var(--red)",
          background: "rgba(248, 113, 113, 0.08)",
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "currentColor",
          }}
        />
        DNS resolves to {dns.ip} — does not match this server ({dns.serverIp})
      </div>
    );
  }

  if (dns.resolves === false) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          marginTop: 6,
          padding: "6px 10px",
          borderRadius: 4,
          color: "var(--yellow)",
          background: "rgba(251, 191, 36, 0.08)",
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "currentColor",
          }}
        />
        DNS does not resolve yet. Certificate provisioning will fail until DNS points to this
        server.
      </div>
    );
  }

  return null;
}
