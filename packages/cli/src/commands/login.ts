import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { clearLogin, loginUrl, readLogin, saveLogin, type LoginConfig } from "../config";
import { parseErrorMessage } from "../../../contract/src/index";

const LOGIN_HELP = `Usage: moor login <server-url> [--password-stdin]

Log in with the admin password. Saves a 30-day session for this machine.
Password input is hidden. Use --password-stdin to read it from a pipe.
Use HTTPS, or a localhost URL through an SSH tunnel.`;

async function passwordPrompt(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error("An interactive terminal is required; use --password-stdin for piped input.");
  process.stderr.write("Password: ");
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      reader.once("SIGINT", () => reject(new Error("Login cancelled.")));
      reader.once("close", () => reject(new Error("Login cancelled.")));
      reader.question("", resolve);
    });
  } finally {
    reader.close();
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

async function revoke(config: LoginConfig): Promise<void> {
  const response = await fetch(`${config.baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      "Could not revoke the saved session. Login is still saved; try moor logout again.",
    );
}

export async function loginCommand(args: string[]): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(LOGIN_HELP);
    return 0;
  }
  try {
    const fromStdin = args[1] === "--password-stdin";
    if (!args[0] || args[0].startsWith("-") || args.length !== (fromStdin ? 2 : 1)) {
      throw new Error(LOGIN_HELP);
    }
    const baseUrl = loginUrl(args[0]);
    if (readLogin())
      throw new Error("A login is already saved. Run moor logout before logging in again.");
    const password = fromStdin
      ? (await Bun.stdin.text()).replace(/\r?\n$/, "")
      : await passwordPrompt();
    if (!password) throw new Error("Password required.");
    const response = await fetch(`${baseUrl}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(parseErrorMessage(await response.text(), response.status));
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("token" in body) ||
      typeof body.token !== "string" ||
      !body.token
    ) {
      throw new Error("Server did not return a session token.");
    }
    const config = { baseUrl, apiKey: body.token };
    try {
      saveLogin(config);
    } catch (error) {
      try {
        await revoke(config);
      } catch {
        throw new Error(
          `Could not save login (${error instanceof Error ? error.message : "write failed"}) or revoke the issued session. Reset the server admin password to revoke it.`,
        );
      }
      throw error;
    }
    console.log(`Logged in to ${baseUrl}. Session expires in 30 days.`);
    if (process.env.MOOR_URL || process.env.MOOR_API_KEY) {
      console.log("MOOR_URL / MOOR_API_KEY override saved login. Unset both to use this session.");
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Login failed.");
    return 1;
  }
}

export async function logoutCommand(args: string[]): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(
      "Usage: moor logout\n\nRevoke and remove the saved login. Environment API keys are unaffected.",
    );
    return 0;
  }
  try {
    if (args.length) throw new Error("Usage: moor logout");
    const config = readLogin();
    if (config) await revoke(config);
    clearLogin();
    console.log("Logged out. Environment API keys are unaffected.");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Logout failed.");
    return 1;
  }
}
