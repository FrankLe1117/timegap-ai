/**
 * Server-side Amap (高德) Web Service client.
 *
 * - Reads `process.env.AMAP_API_KEY` server-side only. Never imported by client code.
 * - Every helper has a short timeout and returns `null` instead of throwing,
 *   so callers can fall back to the internal demo city graph.
 * - Result types are normalized into app-friendly shapes: `AmapPoi`,
 *   `RouteEstimate`. Callers should not depend on raw Amap response shapes.
 *
 * The key is optional — when it is missing every function short-circuits to a
 * cheap "not configured" return, which keeps the existing demo path intact.
 */

const AMAP_TIMEOUT_MS = 4000;
const AMAP_GEOCODE_URL = "https://restapi.amap.com/v3/geocode/geo";
const AMAP_PLACE_TEXT_URL = "https://restapi.amap.com/v3/place/text";
const AMAP_PLACE_AROUND_URL = "https://restapi.amap.com/v3/place/around";
const AMAP_DISTANCE_URL = "https://restapi.amap.com/v3/distance";

export type AmapTravelMode = "driving" | "walking" | "transit";

export interface AmapCoord {
  /** Longitude */
  lng: number;
  /** Latitude */
  lat: number;
}

export interface AmapPoi {
  id: string;
  name: string;
  address?: string;
  coord: AmapCoord;
  type?: string;
  district?: string;
  /** True when `id` was supplied by the upstream API (i.e. a real POI id),
   *  false when we synthesized it because the response omitted one. Reliability
   *  gating downstream depends on this distinction. */
  hasRealId?: boolean;
}

export interface RouteEstimate {
  /** Estimated travel time in minutes (rounded up). */
  minutes: number;
  /** Distance in meters, when available. */
  meters?: number;
  mode: AmapTravelMode;
  /** "amap" if API succeeded, "amap_estimate" if we estimated from distance. */
  source: "amap" | "amap_estimate";
}

export function isAmapConfigured(): boolean {
  return !!process.env.AMAP_API_KEY;
}

function getKey(): string | null {
  const k = process.env.AMAP_API_KEY;
  return k && k.trim().length > 0 ? k.trim() : null;
}

function formatLocation(coord: AmapCoord): string {
  // Amap expects "lng,lat" with up to 6 decimals.
  return `${coord.lng.toFixed(6)},${coord.lat.toFixed(6)}`;
}

function parseLocation(loc: string | undefined): AmapCoord | null {
  if (!loc || typeof loc !== "string") return null;
  const [lngStr, latStr] = loc.split(",");
  const lng = Number(lngStr);
  const lat = Number(latStr);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

async function fetchAmap<T>(url: string, params: Record<string, string>): Promise<T | null> {
  const key = getKey();
  if (!key) return null;

  const qs = new URLSearchParams({ key, output: "JSON", ...params });
  const full = `${url}?${qs.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AMAP_TIMEOUT_MS);
  try {
    const res = await fetch(full, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[amap-client] ${url} returned HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { status?: string; info?: string } & Record<string, unknown>;
    // Amap returns status "1" for success, "0" for failure.
    if (json && json.status !== "1") {
      console.warn(`[amap-client] ${url} returned status=${json?.status} info=${json?.info}`);
      return null;
    }
    return json as T;
  } catch (err) {
    console.warn(`[amap-client] ${url} failed:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geocode a free-text Chinese place name to a coordinate.
 * Falls back through `place/text` when `geocode/geo` returns nothing —
 * structured place names ("陆家嘴") often land in `place/text` first.
 */
export async function geocodePlace(
  query: string,
  city = "上海",
): Promise<AmapPoi | null> {
  if (!query || !query.trim()) return null;
  if (!isAmapConfigured()) return null;

  // Try geocode first.
  type GeocodeResp = {
    geocodes?: Array<{
      formatted_address?: string;
      location?: string;
      adcode?: string;
      district?: string;
    }>;
  };
  const geo = await fetchAmap<GeocodeResp>(AMAP_GEOCODE_URL, {
    address: query.trim(),
    city,
  });
  const g = geo?.geocodes?.[0];
  if (g?.location) {
    const coord = parseLocation(g.location);
    if (coord) {
      return {
        id: `geo:${query}`,
        name: query.trim(),
        address: g.formatted_address,
        coord,
        district: g.district,
      };
    }
  }

  // Fall back to keyword search.
  const tip = await searchPoiByKeyword(query, city, 1);
  return tip[0] || null;
}

/**
 * Keyword POI search. Useful for "陆家嘴 本帮菜" or "外滩 咖啡".
 */
export async function searchPoiByKeyword(
  keyword: string,
  city = "上海",
  limit = 5,
): Promise<AmapPoi[]> {
  if (!keyword || !keyword.trim()) return [];
  if (!isAmapConfigured()) return [];

  type PlaceResp = {
    pois?: Array<{
      id?: string;
      name?: string;
      address?: string;
      location?: string;
      type?: string;
      adname?: string;
    }>;
  };
  const data = await fetchAmap<PlaceResp>(AMAP_PLACE_TEXT_URL, {
    keywords: keyword.trim(),
    city,
    citylimit: "true",
    offset: String(Math.max(1, Math.min(limit, 25))),
    page: "1",
    extensions: "base",
  });
  const pois = data?.pois || [];
  return pois
    .map((p): AmapPoi | null => {
      const coord = parseLocation(p.location);
      if (!coord || !p.name) return null;
      const realId = typeof p.id === "string" && p.id.trim().length > 0;
      return {
        id: realId ? p.id! : `poi:${p.name}`,
        name: p.name,
        address: p.address,
        coord,
        type: p.type,
        district: p.adname,
        hasRealId: realId,
      };
    })
    .filter((x): x is AmapPoi => x !== null);
}

/**
 * Nearby POI search around a coordinate. Used to enrich plans with local
 * candidates near a chosen anchor (start point, attraction, etc.).
 */
export async function searchPoiNearby(
  center: AmapCoord,
  keyword: string,
  radiusMeters = 1500,
  limit = 5,
): Promise<AmapPoi[]> {
  if (!isAmapConfigured()) return [];

  type PlaceResp = {
    pois?: Array<{
      id?: string;
      name?: string;
      address?: string;
      location?: string;
      type?: string;
      adname?: string;
    }>;
  };
  const data = await fetchAmap<PlaceResp>(AMAP_PLACE_AROUND_URL, {
    location: formatLocation(center),
    keywords: keyword.trim() || "",
    radius: String(Math.max(100, Math.min(radiusMeters, 50000))),
    offset: String(Math.max(1, Math.min(limit, 25))),
    page: "1",
    extensions: "base",
  });
  const pois = data?.pois || [];
  return pois
    .map((p): AmapPoi | null => {
      const coord = parseLocation(p.location);
      if (!coord || !p.name) return null;
      const realId = typeof p.id === "string" && p.id.trim().length > 0;
      return {
        id: realId ? p.id! : `poi:${p.name}`,
        name: p.name,
        address: p.address,
        coord,
        type: p.type,
        district: p.adname,
        hasRealId: realId,
      };
    })
    .filter((x): x is AmapPoi => x !== null);
}

/**
 * Estimate travel time between two coordinates.
 *
 * Uses the Amap distance API (`/v3/distance`) which supports type=1 (driving),
 * type=3 (walking). Transit routing requires the direction API and is not
 * exposed here. We map "transit" → driving for time and add a small multiplier
 * because public transit usually trends slower than driving outside rush hour.
 *
 * Returns null when the API key is missing or the call fails. Callers should
 * fall back to the internal city-graph edges in that case.
 */
export async function estimateRoute(
  from: AmapCoord,
  to: AmapCoord,
  mode: AmapTravelMode = "driving",
): Promise<RouteEstimate | null> {
  if (!isAmapConfigured()) return null;

  const amapType = mode === "walking" ? "3" : "1";
  type DistanceResp = {
    results?: Array<{
      distance?: string;
      duration?: string;
    }>;
  };
  const data = await fetchAmap<DistanceResp>(AMAP_DISTANCE_URL, {
    origins: formatLocation(from),
    destination: formatLocation(to),
    type: amapType,
  });
  const r = data?.results?.[0];
  if (!r) return null;

  const distanceMeters = r.distance ? Number(r.distance) : NaN;
  const durationSeconds = r.duration ? Number(r.duration) : NaN;

  let minutes: number;
  let source: RouteEstimate["source"] = "amap";
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    minutes = Math.ceil(durationSeconds / 60);
    if (mode === "transit") {
      // Transit usually a bit slower than driving; conservative bump.
      minutes = Math.ceil(minutes * 1.25);
    }
  } else if (Number.isFinite(distanceMeters) && distanceMeters > 0) {
    // Fallback: estimate from distance assuming average 30km/h driving.
    const speedKmh = mode === "walking" ? 4.5 : mode === "transit" ? 25 : 30;
    minutes = Math.ceil((distanceMeters / 1000) / speedKmh * 60);
    source = "amap_estimate";
  } else {
    return null;
  }

  return {
    minutes,
    meters: Number.isFinite(distanceMeters) ? distanceMeters : undefined,
    mode,
    source,
  };
}

/**
 * Build an Amap URI (高德地图) URL pointing at a single POI marker. When a
 * coordinate is available we use `uri.amap.com/marker?position=...`, which
 * opens both the web map and the mobile app reliably. Otherwise we fall back
 * to a keyword search URL.
 */
export function buildAmapMarkerUrl(name: string, coord?: AmapCoord, srcAppName = "TimeGap AI"): string {
  if (coord) {
    const params = new URLSearchParams({
      position: `${coord.lng},${coord.lat}`,
      name,
      src: srcAppName,
      coordinate: "gaode",
      callnative: "1",
    });
    return `https://uri.amap.com/marker?${params.toString()}`;
  }
  return buildAmapSearchUrl(name);
}

/**
 * Build an Amap keyword search URL. Useful when we don't have coordinates.
 */
export function buildAmapSearchUrl(keyword: string, city = "上海"): string {
  const params = new URLSearchParams({
    keyword,
    city,
    src: "TimeGap AI",
    callnative: "1",
  });
  return `https://uri.amap.com/search?${params.toString()}`;
}

/**
 * Build a navigation URL from one coordinate to another using the Amap URI.
 */
export function buildAmapNavigationUrl(
  from: AmapCoord,
  to: AmapCoord,
  toName: string,
  mode: AmapTravelMode = "driving",
): string {
  const modeMap: Record<AmapTravelMode, string> = {
    driving: "car",
    walking: "walk",
    transit: "bus",
  };
  const params = new URLSearchParams({
    from: `${from.lng},${from.lat}`,
    to: `${to.lng},${to.lat}`,
    tocoord: `${to.lng},${to.lat}`,
    toname: toName,
    mode: modeMap[mode],
    src: "TimeGap AI",
    callnative: "1",
  });
  return `https://uri.amap.com/navigation?${params.toString()}`;
}

/**
 * Build a name-based Amap route URL when we don't have one or both
 * coordinates. Falls back to /amap/?from=&to=&type= which the web map honors
 * for keyword origin/destination lookups. Mode is encoded as `t` per Amap
 * convention: 0 = driving, 1 = transit, 2 = walking.
 */
export function buildAmapRouteByNameUrl(
  fromName: string,
  toName: string,
  mode: AmapTravelMode = "driving",
  city = "上海",
): string {
  const tMap: Record<AmapTravelMode, string> = { driving: "0", transit: "1", walking: "2" };
  const params = new URLSearchParams({
    from: `${fromName},${city}`,
    to: `${toName},${city}`,
    type: tMap[mode],
    src: "TimeGap AI",
    callnative: "1",
  });
  return `https://uri.amap.com/route?${params.toString()}`;
}

/**
 * Build a list of Amap route options for a transport leg. When both
 * coordinates are present, prefers the navigation URI (deep-links into the
 * mobile app). Otherwise falls back to the keyword-based /route URL so the
 * user still gets a routing experience instead of a single marker.
 */
export function buildRouteOptions(
  fromName: string,
  toName: string,
  fromCoord?: AmapCoord | null,
  toCoord?: AmapCoord | null,
): Array<{ mode: "driving" | "transit" | "walking" | "search"; label: string; url: string }> {
  const opts: Array<{ mode: "driving" | "transit" | "walking" | "search"; label: string; url: string }> = [];

  const addNav = (mode: AmapTravelMode, label: string) => {
    if (fromCoord && toCoord) {
      opts.push({ mode, label, url: buildAmapNavigationUrl(fromCoord, toCoord, toName, mode) });
    } else {
      opts.push({ mode, label, url: buildAmapRouteByNameUrl(fromName, toName, mode) });
    }
  };

  addNav("transit", "地铁/公交路线");
  addNav("driving", "驾车路线");
  return opts;
}
