export type IsoDateString = string;

export type LiveStatus = "running" | "stopped" | "error" | "missing";

export type Project = {
  id: number;
  name: string;
  github_url: string | null;
  docker_image: string | null;
  branch: string;
  dockerfile: string;
  image_tag: string | null;
  container_id: string | null;
  status: string;
  domain: string | null;
  domain_port: number | null;
  restart_policy: string;
  memory_limit_mb: number | null;
  cpus: number | null;
  source_credential_id: number | null;
  command: string[] | null;
  entrypoint: string[] | null;
  live_status: LiveStatus | null;
  live_exit_code: number | null;
  live_checked_at: IsoDateString | null;
  live_error: string | null;
  created_at: IsoDateString;
};

export type CreateProjectRequest = {
  name: string;
  github_url?: string | null;
  docker_image?: string | null;
  branch?: string;
  dockerfile?: string;
  domain?: string | null;
  domain_port?: number | null;
  restart_policy?: string;
  memory_limit_mb?: number | null;
  cpus?: number | null;
  source_credential_id?: number | null;
  command?: string[] | null;
  entrypoint?: string[] | null;
};

export type UpdateProjectRequest = Partial<CreateProjectRequest>;

export type DeployRequest = Omit<CreateProjectRequest, "github_url" | "docker_image"> & {
  github_url?: string;
  docker_image?: string;
  volumes?: Array<{ name: string; target: string }>;
  files?: CreateProjectFileRequest[];
  env?: Record<string, string>;
  run?: boolean;
  update_existing?: boolean;
};

export type DeploySummary = {
  action: "created" | "updated";
  project_id: number;
  project_name: string;
  env_keys: string[];
  run: boolean;
  env_changes_pending_restart: boolean;
};

export type DeleteProjectResponse =
  | { ok: true; project_deleted: true; volumes_purged: number }
  | {
      ok: false;
      project_deleted: true;
      caddy_failed: boolean;
      volumes_purged: number;
      volumes_failed: Array<{ name: string; error: string }>;
      message: string;
    };

export type Cron = {
  id: number;
  project_id: number;
  name: string;
  schedule: string;
  command: string;
  timeout_ms: number;
  enabled: number;
  created_at: IsoDateString;
};

export type CreateCronRequest = {
  name: string;
  schedule: string;
  command: string;
  timeout_ms?: number;
};

export type UpdateCronRequest = Partial<CreateCronRequest> & {
  enabled?: number | boolean;
};

export type Run = {
  id: number;
  cron_id: number | null;
  project_id: number;
  started_at: IsoDateString;
  finished_at: IsoDateString | null;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  duration_ms: number | null;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  stdout_total_bytes: number | null;
  stderr_total_bytes: number | null;
  cron_name?: string | null;
  cron_command?: string | null;
};

export type CompactRun = Omit<Run, "stdout" | "stderr"> & {
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_total_bytes: number;
  stderr_total_bytes: number;
  cron_name: string | null;
  cron_command: string | null;
};

export type ListRunsResponse<T extends Run | CompactRun = Run> = {
  runs: T[];
  total: number;
};

export type BuildOutputResponse = Run | { output: null };

export type StopRunResult =
  | "cancelled_cron"
  | "cancelled"
  | "not_cancellable"
  | "already_finished"
  | "not_active"
  | "not_found";

export type StopRunResponse =
  | { ok: true; result: Extract<StopRunResult, "cancelled_cron" | "cancelled"> }
  | { ok: false; result: Exclude<StopRunResult, "cancelled_cron" | "cancelled"> };

export type EnvVar = {
  id: number;
  project_id: number;
  key: string;
  value: string;
};

export type SetEnvVarsRequest = Array<{ key: string; value: string }>;

export type PortMapping = {
  id: number;
  project_id: number;
  host_port: number;
  container_port: number;
  protocol: string;
};

export type Volume = {
  id: number;
  project_id: number;
  name: string;
  target: string;
  docker_name: string;
};

export type CreateVolumeRequest = {
  name: string;
  target: string;
};

export type DeleteVolumeResponse = {
  ok: true;
  docker_name: string;
  message: string;
};

export type ProjectFile =
  | {
      id: number;
      project_id: number;
      path: string;
      mode: string;
      source: "inline";
      env_ref: null;
    }
  | {
      id: number;
      project_id: number;
      path: string;
      mode: string;
      source: "env";
      env_ref: string;
    };

export type CreateProjectFileRequest =
  | { path: string; content: string; env_ref?: never; mode?: string }
  | { path: string; env_ref: string; content?: never; mode?: string };

export type DeleteProjectFileResponse = { ok: true };

export type RedactedSecretKind = "github_classic_pat" | "github_fine_grained_pat" | "unknown";

export type RedactedSecret = {
  configured: true;
  kind: RedactedSecretKind;
};

export type RegistryCredential = {
  id: number;
  hostname: string;
  username: string;
  secret: RedactedSecret;
  created_at: IsoDateString;
  updated_at: IsoDateString;
};

export type ListRegistryCredentialsResponse = {
  rows: RegistryCredential[];
};

export type CreateRegistryCredentialRequest = {
  hostname: string;
  username: string;
  secret: string;
};

export type UpdateRegistryCredentialRequest = {
  username?: string;
  secret?: string;
};

export type SourceCredentialState = "active" | "failed";

export type SourceCredential = {
  id: number;
  hostname: string;
  label: string;
  username: string;
  secret: RedactedSecret;
  state: SourceCredentialState;
  expires_at: IsoDateString | null;
  last_checked_at: IsoDateString | null;
  last_check_status: string | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
};

export type ListSourceCredentialsResponse = {
  rows: SourceCredential[];
};

export type CreateSourceCredentialRequest = {
  hostname: string;
  label: string;
  username: string;
  secret: string;
  expires_at?: IsoDateString | null;
};

export type UpdateSourceCredentialRequest = {
  label?: string;
  username?: string;
  secret?: string;
  expires_at?: IsoDateString | null;
};

export type DeleteSourceCredentialConflict = {
  error: "credential_in_use";
  message: string;
  projects: string[];
};

export type SourceCredentialCheckRequest = {
  github_url: string;
  branch?: string;
  source_credential_id?: number;
};

export type SourceCredentialCheckSuccess = {
  ok: true;
  reachable: true;
  default_branch?: string;
  head_sha?: string;
  ref_sha?: string;
  auto_selected_credential_id?: number;
};

export type SourceCredentialCheckFailure =
  | { ok: false; code: "invalid_url"; reason: string }
  | { ok: false; code: "credential_not_found"; source_credential_id: number }
  | {
      ok: false;
      code: "credential_host_mismatch";
      source_credential_id: number;
      credential_hostname: string;
      request_hostname: string;
    }
  | { ok: false; code: "source_credential_required"; hostname: string }
  | {
      ok: false;
      code: "source_credential_ambiguous";
      hostname: string;
      candidates: Array<{ id: number; label: string }>;
    }
  | { ok: false; code: "credential_not_active"; source_credential_id: number; state: string }
  | { ok: false; code: "clone_auth_failed"; source_credential_id?: number }
  | { ok: false; code: "repo_not_found_or_not_scoped"; source_credential_id?: number }
  | { ok: false; code: "branch_not_found"; branch: string }
  | { ok: false; code: "network_unreachable" }
  | { ok: false; code: "source_access_denied_or_not_found" }
  | { ok: false; code: "git_error" };

export type SourceCredentialCheckResult =
  | SourceCredentialCheckSuccess
  | SourceCredentialCheckFailure;

export type ContainerStats =
  | {
      running: true;
      cpu_percent: number;
      memory_bytes: number;
      memory_limit_bytes: number;
      memory_percent: number;
      network_rx_bytes: number;
      network_tx_bytes: number;
      block_read_bytes: number;
      block_write_bytes: number;
      pids: number;
    }
  | {
      running: false;
      cpu_percent: 0;
      memory_bytes: 0;
      memory_limit_bytes: 0;
      memory_percent: 0;
      network_rx_bytes: 0;
      network_tx_bytes: 0;
      block_read_bytes: 0;
      block_write_bytes: 0;
      pids: 0;
    };

export type ProjectHistorySample = {
  sampled_at_ms: number;
  status: string;
  cpu_percent: number | null;
  mem_bytes: number | null;
  mem_percent: number | null;
  net_rx_rate: number | null;
  net_tx_rate: number | null;
  blk_read_rate: number | null;
  blk_write_rate: number | null;
  pids: number | null;
};

export type ProjectHistoryEvent = {
  occurred_at_ms: number;
  source: string;
  action: string;
  container_id: string | null;
  time_nano: number | null;
};

export type ProjectHistorySummary = {
  sample_count: number;
  running_sample_count: number;
  cpu_percent_avg: number | null;
  cpu_percent_max: number | null;
  mem_bytes_max: number | null;
  net_rx_bytes_total: number;
  net_tx_bytes_total: number;
  event_counts: Record<string, number>;
  has_gap: boolean;
};

export type ProjectHistory = {
  from_ms: number;
  to_ms: number;
  samples: ProjectHistorySample[];
  events: ProjectHistoryEvent[];
  summary: ProjectHistorySummary;
};

export type ServerStats = {
  hostname: string;
  os: string;
  uptime: string;
  cpu: { percent: number; cores: number };
  load: { one_min: number; cores: number; normalized_percent: number };
  memory: { total: string; used: string; percent: number };
  disk: { total: string; used: string; percent: number };
  disks: Array<{ mount: string; total: string; used: string; percent: number; label?: string }>;
  containers: { running: number; total: number };
  docker: DockerDisk | null;
};

export type DockerDiskCategory = {
  bytes: number;
  reclaimable_bytes: number;
  count: number;
  unused_count: number;
};

export type DockerDisk = {
  images: DockerDiskCategory;
  containers: DockerDiskCategory & { stopped_count: number };
  volumes: DockerDiskCategory;
  build_cache: { bytes: number; reclaimable_bytes: number; count: number };
};

export type ActiveWorkCounts = {
  builds_in_flight: number;
  execs_in_flight: number;
  crons_in_flight: number;
  terminals_open: number;
};

export type DrainState = {
  enabled: boolean;
  reason: string | null;
  started_at: IsoDateString | null;
  expires_at: IsoDateString | null;
  clear_after_version: string | null;
};

export type DrainStatusResponse = {
  state: DrainState;
  active_work: ActiveWorkCounts;
};

export type EnableDrainRequest = {
  reason?: string;
  ttl_minutes?: number;
  clear_after_version?: string;
};

export type DrainMutationResponse = {
  state: DrainState;
};

export type DrainRefusal = {
  error: "moor is draining";
  reason: string | null;
  expires_at: IsoDateString | null;
  hint: string;
};

export type UpdateStatus = {
  current: {
    version: string;
    image_id: string | null;
    repo_digest: string | null;
    started_at: IsoDateString;
  };
  available: {
    latest_tag: string;
    latest_digest: string | null;
    update_available: boolean | null;
    registry_error: string | null;
  };
  active_work: ActiveWorkCounts;
  db_backup: {
    last_backup_at: IsoDateString | null;
    age_seconds: number | null;
    location: string | null;
  };
  safe_to_update: boolean;
  unsafe_reasons: string[];
  recommended_command: string;
};

export type UpdateAuditState =
  | "in_progress"
  | "success"
  | "rolled_back"
  | "rollback_failed"
  | "failed"
  | "crashed";

export type UpdateAudit = {
  id: number;
  started_at: IsoDateString;
  started_at_ms: number;
  finished_at: IsoDateString | null;
  finished_at_ms: number | null;
  duration_ms: number | null;
  state: UpdateAuditState;
  from_digest: string | null;
  to_digest: string | null;
  prev_image_id: string | null;
  backup_path: string | null;
  rollback_error: string | null;
  error_log: string | null;
};

export type ListUpdateAuditResponse = {
  rows: UpdateAudit[];
};

export type UpdateApplyRequest = {
  target_digest?: string;
  bypass?: Array<"active_work" | "unknown_digest">;
};

export type UpdateApplyError =
  | { code: "preflight_failed"; reason: string; unsafe_reasons?: string[] }
  | { code: "context_failed"; reason: string }
  | { code: "current_image_unknown"; reason: string }
  | { code: "already_in_progress" }
  | { code: "race_active_work"; counts: Record<string, number> }
  | { code: "backup_failed"; reason: string }
  | { code: "respawner_launch_failed"; reason: string };

export type UpdateApplyResponse = { audit_id: number };

export type UpdateApplyErrorResponse = {
  error: UpdateApplyError;
};

export type LogsResponse = {
  logs: string;
  state?: "ok" | "exited" | "no_container" | "missing";
  lastTimestamp?: number;
};

export type ExecResponse = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type TerminalSession = {
  execId: string;
  projectId: number;
  startedAt: IsoDateString;
  lastCommand: string;
};

export type ListTerminalSessionsResponse = {
  sessions: TerminalSession[];
};
