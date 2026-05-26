/**
 * End-to-end OAuth smoke test:
 * 1. POST /register — dynamic client registration
 * 2. GET /authorize — verify HTML form is rendered
 * 3. POST /authorize — submit access key, capture redirect with code
 * 4. POST /token — exchange code for access token
 * 5. POST /mcp initialize — verify the access token works
 *
 * Usage: BEARER=... node scripts/smoke-oauth.mjs
 */
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const base = "http://127.0.0.1:8787";

let bearer = process.env.BEARER;
if (!bearer) {
  const dev = readFileSync(".dev.vars", "utf8");
  const m = dev.match(/MCP_BEARER_TOKEN=(\S+)/);
  if (!m) throw new Error("MCP_BEARER_TOKEN not found in .dev.vars");
  bearer = m[1];
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

console.log("→ POST /register (dynamic client registration)");
const regRes = await fetch(`${base}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "smoke-test",
    redirect_uris: ["http://localhost:9999/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
console.log("  status:", regRes.status);
const client = await regRes.json();
console.log("  client_id:", client.client_id);

const codeVerifier = b64url(randomBytes(32));
const codeChallenge = b64url(createHash("sha256").update(codeVerifier).digest());
const state = b64url(randomBytes(16));

const authParams = new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: "http://localhost:9999/callback",
  scope: "gsc:read",
  state,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
});

console.log("\n→ GET /authorize");
const authPageRes = await fetch(`${base}/authorize?${authParams}`);
console.log("  status:", authPageRes.status);
const html = await authPageRes.text();
const oauthStateMatch = html.match(/name="oauth_state" value="([^"]+)"/);
if (!oauthStateMatch) {
  console.error("❌ oauth_state hidden field not found in HTML");
  console.error(html.slice(0, 500));
  process.exit(1);
}
const oauthStateField = oauthStateMatch[1];
console.log("  oauth_state field captured:", oauthStateField.slice(0, 32) + "...");

console.log("\n→ POST /authorize with WRONG key (expect 401 + form re-render)");
const wrongRes = await fetch(`${base}/authorize`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    oauth_state: oauthStateField,
    access_key: "this-is-not-the-key",
  }),
  redirect: "manual",
});
console.log("  status:", wrongRes.status, "(expected 401)");

console.log("\n→ POST /authorize with CORRECT key (expect 302 redirect with code)");
const goodRes = await fetch(`${base}/authorize`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    oauth_state: oauthStateField,
    access_key: bearer,
  }),
  redirect: "manual",
});
console.log("  status:", goodRes.status);
const location = goodRes.headers.get("location");
console.log("  redirect:", location?.slice(0, 100));
if (!location) {
  console.error("❌ No location header on success.");
  console.error(await goodRes.text());
  process.exit(1);
}
const redirectUrl = new URL(location);
const code = redirectUrl.searchParams.get("code");
const returnedState = redirectUrl.searchParams.get("state");
console.log("  code:", code?.slice(0, 20) + "...");
console.log("  state matches:", returnedState === state);

console.log("\n→ POST /token (exchange code for access token)");
const tokenRes = await fetch(`${base}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://localhost:9999/callback",
    client_id: client.client_id,
    code_verifier: codeVerifier,
  }),
});
console.log("  status:", tokenRes.status);
const tokenBody = await tokenRes.json();
const accessToken = tokenBody.access_token;
console.log("  access_token:", accessToken?.slice(0, 30) + "...");
console.log("  token_type:", tokenBody.token_type);
console.log("  expires_in:", tokenBody.expires_in);

if (!accessToken) {
  console.error("❌ No access_token in response:", tokenBody);
  process.exit(1);
}

console.log("\n→ POST /mcp initialize (with OAuth access token)");
const mcpRes = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-oauth", version: "0.0.1" },
    },
  }),
});
console.log("  status:", mcpRes.status);
const ct = mcpRes.headers.get("content-type") || "";
const sid = mcpRes.headers.get("mcp-session-id");
console.log("  session-id:", sid);
const text = await mcpRes.text();
let parsed = text;
if (ct.includes("text/event-stream")) {
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) parsed = JSON.parse(dataLine.slice(6));
} else if (ct.includes("application/json")) {
  try {
    parsed = JSON.parse(text);
  } catch {}
}
console.log(
  "  body:",
  JSON.stringify(parsed, null, 2).slice(0, 500),
);

console.log("\n→ POST /mcp tools/list");
await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "mcp-session-id": sid,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }),
});
const toolsRes = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "mcp-session-id": sid,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }),
});
console.log("  status:", toolsRes.status);
const toolsCt = toolsRes.headers.get("content-type") || "";
const toolsText = await toolsRes.text();
let toolsParsed = toolsText;
if (toolsCt.includes("text/event-stream")) {
  const dataLine = toolsText.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) toolsParsed = JSON.parse(dataLine.slice(6));
} else {
  try {
    toolsParsed = JSON.parse(toolsText);
  } catch {}
}
const tools = toolsParsed?.result?.tools ?? [];
console.log("  tool count:", tools.length);
for (const t of tools) console.log("   •", t.name);

console.log("\n✅ OAuth + MCP end-to-end OK.");
