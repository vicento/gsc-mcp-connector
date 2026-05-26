import {
  OAuthProvider,
  type AuthRequest,
  type ClientInfo,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildAuthorizeUrl,
  exchangeCode,
  getValidAccessToken,
  type GoogleOAuthConfig,
} from "./google_auth";
import {
  inspectUrl,
  listSitemaps,
  listSites,
  querySearchAnalytics,
} from "./gsc";

interface Env {
  // OAuth Client (operator's Google project)
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  // Connector access gate (operator-set; users paste this in the login UI)
  MCP_BEARER_TOKEN: string;

  // Cloudflare bindings
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_OBJECT: DurableObjectNamespace;
}

interface GrantProps {
  googleRefreshToken: string;
  grantedAt: number;
  [key: string]: unknown;
}

function googleConfigFromEnv(env: Env, request: Request): GoogleOAuthConfig {
  const url = new URL(request.url);
  return {
    clientId: (env.GOOGLE_OAUTH_CLIENT_ID ?? "").replace(/^﻿/, "").trim(),
    clientSecret: (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").replace(/^﻿/, "").trim(),
    redirectUri: `${url.origin}/oauth/google/callback`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// MCP Agent — exposes 4 GSC tools. Reads Google refresh_token from props.
// ────────────────────────────────────────────────────────────────────────────

const dimensionSchema = z.enum([
  "query",
  "page",
  "country",
  "device",
  "searchAppearance",
  "date",
]);

const searchTypeSchema = z.enum([
  "web",
  "image",
  "video",
  "news",
  "discover",
  "googleNews",
]);

function asJsonContent(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export class GSCMCP extends McpAgent<Env, unknown, GrantProps> {
  server = new McpServer({
    name: "gsc-mcp-connector",
    version: "0.4.0",
  });

  private async accessToken(): Promise<string> {
    const refreshToken = this.props?.googleRefreshToken;
    if (!refreshToken) {
      throw new Error(
        "No Google refresh token in grant. Re-authorize the connector.",
      );
    }
    return getValidAccessToken(
      {
        clientId: (this.env.GOOGLE_OAUTH_CLIENT_ID ?? "").replace(/^﻿/, "").trim(),
        clientSecret: (this.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").replace(/^﻿/, "").trim(),
        redirectUri: "unused-during-refresh",
      },
      refreshToken,
    );
  }

  async init() {
    this.server.tool(
      "list_sites",
      "List every Search Console property the authenticated user has access to. Use this first to discover available siteUrl values.",
      {},
      async () => {
        const token = await this.accessToken();
        const data = await listSites(token);
        return asJsonContent(data);
      },
    );

    this.server.tool(
      "query_search_analytics",
      "Query Google Search Console performance data (clicks, impressions, CTR, average position) for a site. Supports breakdown by query, page, country, device, search appearance, or date.",
      {
        siteUrl: z
          .string()
          .describe(
            "Property identifier (e.g. 'sc-domain:example.com' for a Domain property, or 'https://example.com/' for a URL-prefix property). Get this from list_sites.",
          ),
        startDate: z.string().describe("Start date (YYYY-MM-DD, inclusive)"),
        endDate: z.string().describe("End date (YYYY-MM-DD, inclusive)"),
        dimensions: z
          .array(dimensionSchema)
          .optional()
          .describe("Up to 3 dimensions to group by"),
        type: searchTypeSchema
          .optional()
          .describe("Search type filter (default: web)"),
        rowLimit: z
          .number()
          .int()
          .min(1)
          .max(25000)
          .optional()
          .describe("Max rows to return (default 1000, max 25000)"),
        startRow: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Pagination offset (default 0)"),
        dataState: z
          .enum(["final", "all"])
          .optional()
          .describe("'all' includes fresh data; 'final' is the default"),
        aggregationType: z
          .enum(["auto", "byPage", "byProperty"])
          .optional()
          .describe("How metrics are aggregated"),
        filterDimension: dimensionSchema
          .optional()
          .describe("Optional single-filter convenience: dimension to filter on"),
        filterOperator: z
          .enum([
            "equals",
            "notEquals",
            "contains",
            "notContains",
            "includingRegex",
            "excludingRegex",
          ])
          .optional()
          .describe("Optional single-filter convenience: operator"),
        filterExpression: z
          .string()
          .optional()
          .describe("Optional single-filter convenience: expression"),
      },
      async (args) => {
        const token = await this.accessToken();
        const {
          siteUrl,
          filterDimension,
          filterOperator,
          filterExpression,
          ...rest
        } = args;

        const body: Parameters<typeof querySearchAnalytics>[2] = {
          startDate: rest.startDate,
          endDate: rest.endDate,
          dimensions: rest.dimensions,
          type: rest.type,
          rowLimit: rest.rowLimit ?? 1000,
          startRow: rest.startRow ?? 0,
          dataState: rest.dataState,
          aggregationType: rest.aggregationType,
        };

        if (filterDimension && filterExpression) {
          body.dimensionFilterGroups = [
            {
              groupType: "and",
              filters: [
                {
                  dimension: filterDimension,
                  operator: filterOperator ?? "equals",
                  expression: filterExpression,
                },
              ],
            },
          ];
        }

        const data = await querySearchAnalytics(token, siteUrl, body);
        return asJsonContent(data);
      },
    );

    this.server.tool(
      "inspect_url",
      "Run the URL Inspection API on a single URL: indexing status, last crawl, canonical, mobile usability, AMP and rich-result issues.",
      {
        siteUrl: z
          .string()
          .describe("Property identifier owning the URL (e.g. 'sc-domain:example.com')"),
        inspectionUrl: z
          .string()
          .describe("Fully-qualified URL to inspect, must belong to siteUrl"),
        languageCode: z
          .string()
          .optional()
          .describe("BCP-47 language code, default 'en-US'"),
      },
      async (args) => {
        const token = await this.accessToken();
        const data = await inspectUrl(token, {
          siteUrl: args.siteUrl,
          inspectionUrl: args.inspectionUrl,
          languageCode: args.languageCode ?? "en-US",
        });
        return asJsonContent(data);
      },
    );

    this.server.tool(
      "list_sitemaps",
      "List every sitemap submitted for a Search Console property, with last submission and processing status.",
      {
        siteUrl: z
          .string()
          .describe("Property identifier (e.g. 'sc-domain:example.com')"),
      },
      async (args) => {
        const token = await this.accessToken();
        const data = await listSitemaps(token, args.siteUrl);
        return asJsonContent(data);
      },
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// API handler — only reached after OAuthProvider validated the access token.
// ────────────────────────────────────────────────────────────────────────────

const apiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return GSCMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      return GSCMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ────────────────────────────────────────────────────────────────────────────
// Default handler — public surface.
//
// /              landing
// /health        liveness probe
// /authorize     bearer-key gate, then redirect to Google
// /oauth/google/callback  Google OAuth landing, exchanges code, completes MCP grant
// ────────────────────────────────────────────────────────────────────────────

const LANDING = `gsc-mcp-connector
Self-hosted Google Search Console MCP server on Cloudflare Workers.

Endpoints:
  POST /mcp        Streamable HTTP MCP transport (requires OAuth access token)
  GET  /sse        Server-Sent Events MCP transport (legacy clients)
  GET  /authorize  OAuth 2.1 login UI (bearer + Google)

OAuth metadata:
  /.well-known/oauth-authorization-server

Source: https://github.com/JuJu78/gsc-mcp-connector
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loginPage(opts: {
  oauthState: string;
  clientName: string;
  clientId: string;
  scope: string[];
  error?: string;
}): string {
  const errorBlock = opts.error
    ? `<div class="error">${escapeHtml(opts.error)}</div>`
    : "";

  const scopeBlock = opts.scope.length
    ? `<p class="scope">Requested MCP scopes: <code>${escapeHtml(opts.scope.join(" "))}</code></p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gsc-mcp-connector — Authorize</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  body { max-width: 480px; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  .sub { color: #666; font-size: .9rem; margin-top: 0; }
  .client { background: rgba(127,127,127,.08); border: 1px solid rgba(127,127,127,.2); border-radius: 6px; padding: 1rem; margin: 1.5rem 0; }
  .client b { display: block; font-size: 1.05rem; }
  .scope { font-size: .85rem; color: #666; margin: .5rem 0 0; }
  label { display: block; font-weight: 600; margin: 1rem 0 .25rem; }
  input[type=password] { width: 100%; padding: .65rem .8rem; font-size: 1rem; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, monospace; }
  button { margin-top: 1.25rem; width: 100%; padding: .8rem; font-size: 1rem; font-weight: 600; border-radius: 6px; border: 0; background: #2563eb; color: white; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .error { background: #fee2e2; color: #991b1b; padding: .65rem .8rem; border-radius: 6px; font-size: .9rem; margin: 1rem 0; }
  .hint { font-size: .8rem; color: #888; margin-top: 1rem; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .85em; background: rgba(127,127,127,.12); padding: 1px 5px; border-radius: 3px; }
  .steps { font-size: .85rem; color: #666; margin: 1rem 0 0; padding-left: 1.2rem; }
  .steps li { margin: .25rem 0; }
</style>
</head>
<body>
<h1>Authorize MCP client</h1>
<p class="sub">A client wants to use this connector to query your Google Search Console data.</p>

<div class="client">
  <b>${escapeHtml(opts.clientName || "Unknown client")}</b>
  <span class="scope"><code>client_id: ${escapeHtml(opts.clientId)}</code></span>
  ${scopeBlock}
</div>

${errorBlock}

<form method="POST" action="/authorize" autocomplete="off">
  <input type="hidden" name="oauth_state" value="${escapeHtml(opts.oauthState)}">
  <label for="access_key">Connector access key</label>
  <input type="password" id="access_key" name="access_key" required autofocus
         placeholder="MCP_BEARER_TOKEN">
  <button type="submit">Continue with Google →</button>
</form>

<ol class="steps">
  <li>Paste the access key set at deploy time (<code>MCP_BEARER_TOKEN</code>).</li>
  <li>You will be redirected to Google to grant <code>webmasters.readonly</code> access.</li>
  <li>After granting, you return to ${escapeHtml(opts.clientName || "the client")} authorized.</li>
</ol>
</body>
</html>`;
}

// We pack two pieces into Google's `state` param:
//   - the original MCP AuthRequest (so we can complete it on Google callback)
//   - a random nonce to bind the redirect to this instance
function packGoogleState(oauthReq: AuthRequest): string {
  return btoa(
    JSON.stringify({
      v: 1,
      req: oauthReq,
      nonce: crypto.randomUUID(),
    }),
  );
}

interface PackedState {
  v: number;
  req: AuthRequest;
  nonce: string;
}

function unpackGoogleState(state: string): PackedState {
  const decoded = JSON.parse(atob(state)) as PackedState;
  if (decoded.v !== 1 || !decoded.req || !decoded.nonce) {
    throw new Error("Invalid state");
  }
  return decoded;
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(LANDING, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain" },
      });
    }

    // ── /authorize GET: render bearer-key form ───────────────────────────
    if (url.pathname === "/authorize" && request.method === "GET") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      let clientInfo: ClientInfo | null = null;
      try {
        clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
      } catch {
        clientInfo = null;
      }

      const html = loginPage({
        oauthState: btoa(JSON.stringify(oauthReqInfo)),
        clientName: clientInfo?.clientName || oauthReqInfo.clientId,
        clientId: oauthReqInfo.clientId,
        scope: oauthReqInfo.scope ?? [],
      });

      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // ── /authorize POST: validate bearer, redirect to Google ─────────────
    if (url.pathname === "/authorize" && request.method === "POST") {
      const formData = await request.formData();
      const submittedKey = formData.get("access_key");
      const oauthStateRaw = formData.get("oauth_state");

      if (typeof oauthStateRaw !== "string" || !oauthStateRaw) {
        return new Response("Missing oauth_state", { status: 400 });
      }

      let oauthReqInfo: AuthRequest;
      try {
        oauthReqInfo = JSON.parse(atob(oauthStateRaw)) as AuthRequest;
      } catch {
        return new Response("Invalid oauth_state", { status: 400 });
      }

      const expected = (env.MCP_BEARER_TOKEN ?? "").trim();
      const provided =
        typeof submittedKey === "string" ? submittedKey.trim() : "";

      if (!expected || !provided || provided !== expected) {
        const html = loginPage({
          oauthState: oauthStateRaw,
          clientName: oauthReqInfo.clientId,
          clientId: oauthReqInfo.clientId,
          scope: oauthReqInfo.scope ?? [],
          error: "Invalid access key. Try again.",
        });
        return new Response(html, {
          status: 401,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      // Bearer OK → redirect to Google.
      const googleConfig = googleConfigFromEnv(env, request);
      if (!googleConfig.clientId || !googleConfig.clientSecret) {
        return new Response(
          "Server misconfigured: GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET is missing.",
          { status: 500 },
        );
      }

      const googleState = packGoogleState(oauthReqInfo);
      const googleAuthorizeUrl = buildAuthorizeUrl(googleConfig, googleState);
      return Response.redirect(googleAuthorizeUrl, 302);
    }

    // ── /oauth/google/callback: exchange code, complete MCP grant ────────
    if (url.pathname === "/oauth/google/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const googleError = url.searchParams.get("error");

      if (googleError) {
        return new Response(
          `Google declined the authorization: ${googleError}. Close this tab and retry from the client.`,
          { status: 400, headers: { "content-type": "text/plain" } },
        );
      }

      if (!code || !state) {
        return new Response("Missing code or state", { status: 400 });
      }

      let unpacked: PackedState;
      try {
        unpacked = unpackGoogleState(state);
      } catch {
        return new Response("Invalid state", { status: 400 });
      }

      const googleConfig = googleConfigFromEnv(env, request);
      let tokens;
      try {
        tokens = await exchangeCode(googleConfig, code);
      } catch (e) {
        return new Response(
          `Google token exchange failed: ${(e as Error).message}`,
          { status: 502, headers: { "content-type": "text/plain" } },
        );
      }

      const props: GrantProps = {
        googleRefreshToken: tokens.refreshToken,
        grantedAt: Date.now(),
      };

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: unpacked.req,
        userId: "operator",
        metadata: { provider: "google-oauth", scope: tokens.scope },
        scope: unpacked.req.scope ?? ["gsc:read"],
        props,
      });

      return Response.redirect(redirectTo, 302);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ────────────────────────────────────────────────────────────────────────────

export default new OAuthProvider({
  apiRoute: ["/mcp", "/sse"],
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["gsc:read"],
});
