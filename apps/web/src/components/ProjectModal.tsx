import { useEffect, useRef, useState } from "react";
import type { Project } from "../lib/api";

type SourceType = "github" | "image";

type ProjectData = {
  name: string;
  github_url?: string | null;
  docker_image?: string | null;
  branch?: string;
  dockerfile?: string;
};

type Props = {
  project?: Project;
  onClose: () => void;
  onSave: (data: ProjectData) => Promise<void>;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError("");
    setLoading(true);
    try {
      if (source === "image") {
        await onSave({
          name: name.trim(),
          docker_image: dockerImage.trim() || undefined,
          github_url: null,
        });
      } else {
        await onSave({
          name: name.trim(),
          github_url: githubUrl.trim() || undefined,
          docker_image: null,
          branch: branch.trim() || "main",
          dockerfile: dockerfile.trim() || "Dockerfile",
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  };

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
        {error && <div style={{ color: "var(--red, #e55)", fontSize: "0.9em" }}>{error}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || loading}>
            {loading ? "Saving..." : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
