/**
 * Google OAuth 2.0 helpers (user flow).
 *
 * The connector acts as an OAuth client to Google. The end-user logs in once
 * with their Google account, granting `webmasters.readonly`. We store the
 * resulting refresh_token in the MCP grant's props; on every tool call we
 * refresh a short-lived access_token to call the Search Console API.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scope?: string;
  idToken?: string;
}

export function buildAuthorizeUrl(
  config: GoogleOAuthConfig,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    include_granted_scopes: "true",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(
  config: GoogleOAuthConfig,
  code: string,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Google token exchange failed (${res.status}): ${errorText}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    id_token?: string;
  };

  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Ensure the OAuth Client requested access_type=offline and prompt=consent.",
    );
  }

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
    idToken: data.id_token,
  };
}

export async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number; scope?: string }> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Google token refresh failed (${res.status}): ${errorText}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

/**
 * Returns a Google access_token that is valid right now. Always refreshes —
 * we don't have a writable per-request cache that survives the OAuth grant
 * boundary. The refresh round-trip is ~100ms and Google's quota is generous.
 */
export async function getValidAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<string> {
  const refreshed = await refreshAccessToken(config, refreshToken);
  return refreshed.accessToken;
}
