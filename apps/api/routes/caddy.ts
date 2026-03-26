import { checkDns } from "../caddy";

export async function handleCaddy(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/dns-check" && req.method === "POST") {
    const body = (await req.json()) as { domain?: string };
    if (!body.domain?.trim()) {
      return new Response("domain is required", { status: 400 });
    }
    const result = await checkDns(body.domain.trim());
    return Response.json(result);
  }

  return null;
}
