import { timingSafeEqual } from "node:crypto";
import db from "./db";

const SESSION_DURATION_HOURS = 72;

export function isSetupComplete(): boolean {
  return db.query("SELECT id FROM auth WHERE id = 1").get() !== null;
}

export async function verifyPassword(password: string): Promise<boolean> {
  const row = db.query("SELECT password_hash FROM auth WHERE id = 1").get() as {
    password_hash: string;
  } | null;
  if (!row) return false;
  return Bun.password.verify(password, row.password_hash);
}

export function createSession(): string {
  const token = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DURATION_HOURS * 60 * 60 * 1000);
  db.query("INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)").run(
    token,
    now.toISOString(),
    expires.toISOString(),
  );
  return token;
}

export function validateSession(token: string): boolean {
  const row = db
    .query("SELECT token FROM sessions WHERE token = ? AND expires_at > datetime('now')")
    .get(token);
  return row !== null;
}

export function deleteSession(token: string): void {
  db.query("DELETE FROM sessions WHERE token = ?").run(token);
}

export function cleanExpiredSessions(): void {
  db.query("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

export function getSessionFromCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(/(?:^|;\s*)moor_session=([^\s;]+)/);
  return match ? match[1] : null;
}

export function buildSessionCookie(token: string, req: Request): string {
  const parts = [
    `moor_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_DURATION_HOURS * 3600}`,
  ];
  const proto = req.headers.get("x-forwarded-proto") || new URL(req.url).protocol.replace(":", "");
  if (proto === "https") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function buildClearCookie(): string {
  return "moor_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}

export function validateBearerToken(req: Request): boolean {
  const apiKey = process.env.MOOR_API_KEY;
  if (!apiKey) return false;

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.slice(7);
  if (token.length !== apiKey.length) return false;

  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(token), encoder.encode(apiKey));
}

/** Process MOOR_INITIAL_PASSWORD on startup. Create-only: warns and skips if an admin
 *  already exists, so leaving it set in compose is not destructive. */
export function checkInitialPassword(): void {
  const initial = process.env.MOOR_INITIAL_PASSWORD;
  if (!initial) return;

  if (process.env.MOOR_RESET_PASSWORD) {
    throw new Error(
      "Both MOOR_INITIAL_PASSWORD and MOOR_RESET_PASSWORD are set. " +
        "Pick one - they have different semantics (create vs reset). Aborting startup.",
    );
  }

  if (isSetupComplete()) {
    console.warn(
      "[auth] MOOR_INITIAL_PASSWORD is set but an admin already exists. " +
        "Ignoring (use MOOR_RESET_PASSWORD to reset).",
    );
    delete process.env.MOOR_INITIAL_PASSWORD;
    return;
  }

  if (initial.length < 8) {
    throw new Error("MOOR_INITIAL_PASSWORD must be at least 8 characters");
  }

  console.log("[auth] MOOR_INITIAL_PASSWORD detected - creating initial admin");
  const hash = Bun.password.hashSync(initial, { algorithm: "argon2id" });
  db.query("INSERT INTO auth (id, password_hash) VALUES (1, ?)").run(hash);
  delete process.env.MOOR_INITIAL_PASSWORD;
  console.log("[auth] Initial admin created.");
}

export function checkPasswordReset(): void {
  const newPassword = process.env.MOOR_RESET_PASSWORD;
  if (!newPassword) return;

  console.log("[auth] MOOR_RESET_PASSWORD detected - resetting password");
  const hash = Bun.password.hashSync(newPassword, { algorithm: "argon2id" });
  db.query("DELETE FROM auth WHERE id = 1").run();
  db.query("INSERT INTO auth (id, password_hash) VALUES (1, ?)").run(hash);
  db.query("DELETE FROM sessions").run();
  delete process.env.MOOR_RESET_PASSWORD;
  console.log("[auth] Password reset complete.");
}
