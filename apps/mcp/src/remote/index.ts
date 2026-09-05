import { createRemoteApp, type RemoteEnv } from "./app.ts";

export default {
  async fetch(request: Request, env: RemoteEnv): Promise<Response> {
    // A newly provisioned Worker is deliberately inert until provider setup is
    // complete. Never point discovery at upstream's OAuth server as a fallback.
    const ready = Boolean(
      env.CLERK_ISSUER && env.CLERK_JWT_KEY && env.DATABASE_URL && env.FITIA_SESSION_ENCRYPTION_KEY,
    );
    if (!ready) {
      const url = new URL(request.url);
      const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
      if (!env.ALLOWED_HOSTS.split(",").includes(url.host)) return new Response(null, { status: 403 });
      if (url.pathname === "/health") return Response.json({ ok: true, ready: false }, { headers });
      if (url.pathname === "/")
        return Response.json({ name: "Private Fitia MCP", status: "Provider authorization pending" }, { headers });
      if (url.pathname === "/mcp" && !request.headers.has("authorization")) {
        return Response.json(
          { error: "unauthorized", ready: false },
          {
            status: 401,
            headers: {
              ...headers,
              "WWW-Authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", env.MCP_RESOURCE)}"`,
            },
          },
        );
      }
      return Response.json({ error: "Service setup is incomplete" }, { status: 503, headers });
    }
    return await createRemoteApp(env).fetch(request, env);
  },
};
