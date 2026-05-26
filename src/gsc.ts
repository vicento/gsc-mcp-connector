/**
 * Thin wrapper over Google Search Console v3 REST API.
 * https://developers.google.com/webmaster-tools/v1/api_reference_index
 */

const GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

async function gscFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${GSC_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GSC API ${response.status} on ${path}: ${errorText}`);
  }

  return response.json() as Promise<T>;
}

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export async function listSites(token: string): Promise<{ siteEntry?: SiteEntry[] }> {
  return gscFetch("/sites", token);
}

export type Dimension =
  | "query"
  | "page"
  | "country"
  | "device"
  | "searchAppearance"
  | "date";

export type SearchType =
  | "web"
  | "image"
  | "video"
  | "news"
  | "discover"
  | "googleNews";

export interface DimensionFilter {
  dimension: Dimension;
  operator?: "equals" | "notEquals" | "contains" | "notContains" | "includingRegex" | "excludingRegex";
  expression: string;
}

export interface DimensionFilterGroup {
  groupType?: "and";
  filters: DimensionFilter[];
}

export interface SearchAnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  dimensionFilterGroups?: DimensionFilterGroup[];
  rowLimit?: number;
  startRow?: number;
  dataState?: "final" | "all";
  aggregationType?: "auto" | "byPage" | "byProperty";
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function querySearchAnalytics(
  token: string,
  siteUrl: string,
  body: SearchAnalyticsQuery,
): Promise<{ rows?: SearchAnalyticsRow[]; responseAggregationType?: string }> {
  const path = `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  return gscFetch(path, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listSitemaps(
  token: string,
  siteUrl: string,
): Promise<unknown> {
  const path = `/sites/${encodeURIComponent(siteUrl)}/sitemaps`;
  return gscFetch(path, token);
}

export interface InspectUrlRequest {
  inspectionUrl: string;
  siteUrl: string;
  languageCode?: string;
}

export async function inspectUrl(
  token: string,
  body: InspectUrlRequest,
): Promise<unknown> {
  const response = await fetch(
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `URL Inspection API ${response.status}: ${errorText}`,
    );
  }

  return response.json();
}
