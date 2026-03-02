import { join } from "node:path";
import { startCronScheduler } from "./cron";
import { handleCrons } from "./routes/crons";
import { handleDocker } from "./routes/docker";
import { handleEnvs } from "./routes/envs";
import { handleProjects } from "./routes/projects";
import { handleRuns } from "./routes/runs";

// Initialize DB (side-effect import runs migrations)
import "./db";

const PORT = Number(process.env.PORT || 3000);
const clientDist = join(import.meta.dir, "..", "web", "dist");

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req) {
    const url = new URL(req.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      try {
        const res =
          (await handleProjects(req, url)) ??
          (await handleDocker(req, url)) ??
          (await handleCrons(req, url)) ??
          (await handleEnvs(req, url)) ??
          handleRuns(req, url);

        if (res) return res;
      } catch (e) {
        console.error("[api error]", e);
        const message = e instanceof Error ? e.message : "Internal server error";
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    }

    // Serve built client (production)
    if (url.pathname !== "/" && url.pathname !== "/index.html") {
      const file = Bun.file(join(clientDist, url.pathname));
      if (await file.exists()) return new Response(file);
    }

    // SPA fallback
    const index = Bun.file(join(clientDist, "index.html"));
    if (await index.exists()) return new Response(index);

    return new Response("Run 'bun run build' in client/ first", { status: 503 });
  },
});

startCronScheduler();

console.log(`Dinghy running at http://localhost:${server.port}`);
