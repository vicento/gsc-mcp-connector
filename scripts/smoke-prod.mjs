/**
 * Drives the full OAuth + MCP flow against PRODUCTION to verify the bearer
 * stored as MCP_BEARER_TOKEN matches what we expect.
 *
 * Usage: BEARER=<value> node scripts/smoke-prod.mjs
 */
import { createHash, randomBytes } from "node:crypto";

const base = "https://gsc-mcp-connector.juliengourdon79.workers.dev";

const bearer = process.env.BEARER;
if (!bearer) {
  console.error("Set BEARER env var");
  process.exit(1);
}
console.log("bearer length:", bearer.length, "first 8:", bearer.slice(0, 8));

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

console.log("\n→ POST /register");
const reg = await fetch(`${base}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "smoke-prod",
    redirect_uris: ["http://localhost:9999/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
console.log("  status:", reg.status);
const client = await reg.json();
console.log("  client_id:", client.client_id);

const cv = b64url(randomBytes(32));
const cc = b64url(createHash("sha256").update(cv).digest());
const state = b64url(randomBytes(16));

const params = new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: "http://localhost:9999/callback",
  scope: "gsc:read",
  state,
  code_challenge: cc,
  code_challenge_method: "S256",
});

console.log("\n→ GET /authorize");
const page = await fetch(`${base}/authorize?${params}`);
console.log("  status:", page.status);
const html = await page.text();
const m = html.match(/name="oauth_state" value="([^"]+)"/);
if (!m) {
  console.error("oauth_state field missing");
  console.error(html.slice(0, 800));
  process.exit(1);
}

console.log("\n→ POST /authorize with bearer");
const post = await fetch(`${base}/authorize`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    oauth_state: m[1],
    access_key: bearer,
  }),
  redirect: "manual",
});
console.log("  status:", post.status);
if (post.status !== 302) {
  const body = await post.text();
  const errMatch = body.match(/class="error">([^<]+)/);
  console.log("  error in HTML:", errMatch ? errMatch[1] : "(none)");
  console.log("\n❌ Bearer comparison fails server-side.");
  process.exit(1);
}

const loc = post.headers.get("location");
console.log("  → 302 redirect:", loc?.slice(0, 80));
const code = new URL(loc).searchParams.get("code");

console.log("\n→ POST /token");
const tk = await fetch(`${base}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://localhost:9999/callback",
    client_id: client.client_id,
    code_verifier: cv,
  }),
});
console.log("  status:", tk.status);
const tkBody = await tk.json();
const accessToken = tkBody.access_token;
console.log("  access_token:", accessToken?.slice(0, 30) + "...");

async function rpc(body, sid) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
  };
  if (sid) headers["mcp-session-id"] = sid;
  const r = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  const newSid = r.headers.get("mcp-session-id");
  const text = await r.text();
  let parsed = text;
  if (ct.includes("text/event-stream")) {
    const dl = text.split("\n").find((l) => l.startsWith("data: "));
    if (dl) parsed = JSON.parse(dl.slice(6));
  } else if (ct.includes("application/json")) {
    try { parsed = JSON.parse(text); } catch {}
  }
  return { status: r.status, sid: newSid, body: parsed };
}

console.log("\n→ /mcp initialize");
const init = await rpc({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-prod", version: "0.0.1" } },
});
console.log("  status:", init.status, "session:", init.sid?.slice(0, 16) + "...");

await rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sid);

console.log("\n→ /mcp tools/list");
const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sid);
console.log("  status:", tools.status);
const toolList = tools.body?.result?.tools ?? [];
console.log("  tool count:", toolList.length);

console.log("\n→ /mcp tools/call list_sites (REAL Google API call)");
const call = await rpc({
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name: "list_sites", arguments: {} },
}, init.sid);
console.log("  status:", call.status);
const text = call.body?.result?.content?.[0]?.text;
if (text) {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data.siteEntry)) {
      console.log("  ✅ Got", data.siteEntry.length, "GSC properties:");
      for (const s of data.siteEntry) console.log("   •", s.siteUrl, `(${s.permissionLevel})`);
    } else {
      console.log("  Response (no siteEntry):", JSON.stringify(data, null, 2).slice(0, 400));
    }
  } catch {
    console.log("  Raw text:", text.slice(0, 400));
  }
} else {
  console.log("  body:", JSON.stringify(call.body, null, 2).slice(0, 400));
}
