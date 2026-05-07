/**
 * Directional-suggestion resolver.
 *
 * After `sanitizePlan` rewrites a synthetic demo stop into a directional
 * suggestion ("黄浦区附近找一家老字号餐厅小馆（方向建议）"), this module
 * tries to upgrade that suggestion into a real Amap POI. If the search
 * returns a candidate that passes the same reliability gate used by
 * `candidate-pool` (real upstream id, address, category-matching type,
 * non-synthetic name, plausible coord, near the anchor), we replace the
 * directional stop with that concrete POI — so the user finally gets a
 * clickable "在高德打开" link instead of a vague suggestion.
 *
 * If no candidate clears the gate, the directional suggestion is kept
 * intact (no coord, no amap_url, `place_kind: "directional"`).
 *
 * The resolver is server-only and Amap-dependent: when `AMAP_API_KEY` is
 * missing every helper short-circuits and the response passes through
 * untouched.
 */
import {
  AmapCoord,
  AmapPoi,
  buildAmapMarkerUrl,
  buildAmapNavigationUrl,
  buildRouteOptions,
  isAmapConfigured,
  searchPoiByKeyword,
  searchPoiNearby,
} from "./amap-client";
import type {
  Plan,
  PlanResponse,
  RouteHop,
  TimelineItem,
} from "@/types";
import { collectUsedKeys, stopKey } from "./plan-dedupe";

/** Build the dedupe key Amap POIs map to. Mirrors `stopKey` for resolved stops:
 *  prefer the real upstream id, otherwise normalized name + ~110 m bucket. */
function poiDedupeKey(poi: AmapPoi): string {
  if (poi.hasRealId && poi.id && !poi.id.startsWith("poi:") && !poi.id.startsWith("geo:")) {
    return `id:${poi.id}`;
  }
  const name = (poi.name || "").trim().toLowerCase().replace(/\s+/g, "");
  return `nc:${name}@${poi.coord.lng.toFixed(3)},${poi.coord.lat.toFixed(3)}`;
}

/**
 * Decoded intent for a directional suggestion. We extract this from the
 * place_name / title so we can build sensible Amap queries.
 */
export interface DirectionalIntent {
  /** Coarse area/district/landmark hint — "黄浦区", "新天地", "武康路". */
  area?: string;
  /** Category hint based on activity / cuisine — "本帮菜", "老字号餐厅", "咖啡". */
  category: string;
  /** Activity bucket the resolved POI must match. */
  activity: TimelineItem["activity_type"];
}

/** Amap search functions, abstracted so smoke tests can inject mocks. */
export interface AmapSearchDeps {
  searchByKeyword: typeof searchPoiByKeyword;
  searchNearby: typeof searchPoiNearby;
}

const DEFAULT_DEPS: AmapSearchDeps = {
  searchByKeyword: searchPoiByKeyword,
  searchNearby: searchPoiNearby,
};

const KNOWN_AREAS = [
  "黄浦区",
  "徐汇区",
  "长宁区",
  "静安区",
  "普陀区",
  "虹口区",
  "杨浦区",
  "浦东新区",
  "闵行区",
  "宝山区",
  "嘉定区",
  "金山区",
  "松江区",
  "青浦区",
  "奉贤区",
  "崇明区",
];

const KNOWN_LANDMARKS = [
  "新天地",
  "外滩",
  "陆家嘴",
  "武康路",
  "人民广场",
  "南京路",
  "南京东路",
  "南京西路",
  "城隍庙",
  "豫园",
  "静安寺",
  "徐家汇",
  "田子坊",
  "虹桥",
  "虹桥火车站",
  "虹桥天地",
  "五角场",
  "中山公园",
];

/** Tail tokens for category extraction (kept in sync with place-sanitize). */
const CATEGORY_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: /老字号/, category: "老字号餐厅" },
  { re: /本帮|上海菜/, category: "本帮菜" },
  { re: /法式|法餐/, category: "法餐" },
  { re: /日料/, category: "日料" },
  { re: /咖啡/, category: "咖啡" },
  { re: /茶馆?/, category: "茶馆" },
  { re: /小吃|快餐|简餐/, category: "本地小吃" },
  { re: /餐厅|小馆|餐馆|饭馆|食堂|酒楼|小酒馆|酒馆/, category: "餐厅" },
];

/**
 * Extract `{area, category, activity}` from a directional TimelineItem. The
 * `place_name` was emitted by `buildDirectionalText` in place-sanitize.ts;
 * we reverse-engineer it back into structured intent.
 */
export function extractDirectionalIntent(item: TimelineItem): DirectionalIntent {
  const text = `${item.title || ""} ${item.place_name || ""}`;
  let area: string | undefined;
  for (const a of KNOWN_AREAS) {
    if (text.includes(a)) {
      area = a;
      break;
    }
  }
  if (!area) {
    for (const lm of KNOWN_LANDMARKS) {
      if (text.includes(lm)) {
        area = lm;
        break;
      }
    }
  }

  let category = "餐厅";
  if (item.activity_type === "coffee") category = "咖啡";
  for (const { re, category: cat } of CATEGORY_PATTERNS) {
    if (re.test(text)) {
      category = cat;
      break;
    }
  }

  return { area, category, activity: item.activity_type };
}

/**
 * Build a small set of Amap keyword queries from intent. Ordered most→least
 * specific so the first one tends to land the best match.
 */
export function buildIntentQueries(intent: DirectionalIntent): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const t = q.trim().replace(/\s+/g, " ");
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  const a = intent.area || "";
  const cat = intent.category;

  if (a) {
    push(`${a} ${cat}`);
    if (cat === "本帮菜") push(`${a} 上海菜`);
    if (cat === "老字号餐厅") push(`${a} 老字号 餐厅`);
    if (cat === "餐厅") push(`${a} 本帮菜`);
  }
  // Bare category last, so we always have a terminal fallback.
  push(cat);

  return out.slice(0, 3);
}

/**
 * Reliability gate, mirroring `candidate-pool.classifyReliability` for the
 * commercial categories that directional suggestions cover.
 *
 * A POI is considered reliable iff it has a real upstream id, a non-empty
 * address, a category-matching type, a non-synthetic-looking name, valid
 * coord, and (when `anchor` is given) sits within ~5 km of it.
 */
const COMMERCIAL_TYPE_KEYWORDS: Record<string, string[]> = {
  // Activity → list of substrings any one of which must appear in `type`.
  coffee: ["咖啡", "饮品", "茶饮", "甜品", "cafe", "coffee", "tea"],
  lunch: ["餐饮", "美食", "餐厅", "中餐", "西餐", "本帮", "小吃", "restaurant", "food"],
  dinner: ["餐饮", "美食", "餐厅", "中餐", "西餐", "本帮", "小吃", "restaurant", "food"],
};

const SYNTHETIC_NAME_RE =
  /^.{0,10}(本帮|小馆|餐厅|餐馆|饭馆|食堂|酒楼|咖啡店?|咖啡馆|景点|景区|公园|博物馆|美术馆)$/u;

function nameLooksSynthetic(name: string): boolean {
  const n = (name || "").trim();
  if (!n) return true;
  return SYNTHETIC_NAME_RE.test(n);
}

function coordIsValid(coord: AmapCoord | undefined | null): coord is AmapCoord {
  if (!coord) return false;
  const { lng, lat } = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lng < 73 || lng > 136) return false;
  if (lat < 17 || lat > 54) return false;
  return true;
}

function kmBetween(a: AmapCoord, b: AmapCoord): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(sa));
}

export function isPoiReliableForActivity(
  poi: AmapPoi,
  activity: TimelineItem["activity_type"],
  anchor?: AmapCoord | null,
): boolean {
  const hasRealId =
    !!poi.hasRealId && !poi.id.startsWith("poi:") && !poi.id.startsWith("geo:");
  if (!hasRealId) return false;
  if (!poi.address || !poi.address.trim()) return false;
  if (nameLooksSynthetic(poi.name)) return false;
  if (!coordIsValid(poi.coord)) return false;

  const keywords = COMMERCIAL_TYPE_KEYWORDS[activity];
  if (!keywords) return false;
  const t = (poi.type || "").toLowerCase();
  if (!keywords.some((kw) => t.includes(kw.toLowerCase()))) return false;

  if (anchor) {
    if (kmBetween(anchor, poi.coord) > 6) return false;
  }
  return true;
}

/**
 * Return the first POI from `pois` that passes the reliability gate AND
 * whose dedupe key is not already in `usedKeys`. Preserves input order —
 * callers should pre-rank by proximity if desired.
 *
 * `usedKeys` lets us skip a POI that an earlier slot in the same plan has
 * already locked in (e.g. lunch picked it; we want a different dinner spot).
 */
function pickReliable(
  pois: AmapPoi[],
  activity: TimelineItem["activity_type"],
  anchor?: AmapCoord | null,
  usedKeys?: Set<string>,
): AmapPoi | null {
  for (const p of pois) {
    if (!isPoiReliableForActivity(p, activity, anchor)) continue;
    if (usedKeys && usedKeys.has(poiDedupeKey(p))) continue;
    return p;
  }
  return null;
}

/**
 * Try to resolve a single directional stop. Runs a few Amap queries and
 * returns the first reliable POI, or null when nothing passes the gate.
 *
 * `anchor` is the most recent coord we know (start point or the previous
 * stop) — used both to constrain `searchPoiNearby` and to gate distance.
 */
export async function resolveDirectionalStop(
  intent: DirectionalIntent,
  anchor: AmapCoord | null,
  city = "上海",
  deps: AmapSearchDeps = DEFAULT_DEPS,
  usedKeys?: Set<string>,
): Promise<AmapPoi | null> {
  const queries = buildIntentQueries(intent);

  for (const q of queries) {
    let pois: AmapPoi[] = [];
    if (anchor) {
      pois = await deps.searchNearby(anchor, q, 2500, 5);
    }
    if (!pois.length) {
      pois = await deps.searchByKeyword(q, city, 5);
    }
    const pick = pickReliable(pois, intent.activity, anchor, usedKeys);
    if (pick) return pick;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Plan-level integration                                                     */
/* -------------------------------------------------------------------------- */

function isDirectionalStop(item: TimelineItem): boolean {
  if (item.activity_type === "transport" || item.activity_type === "station_buffer") {
    return false;
  }
  return item.place_kind === "directional";
}

function activityLabel(activity: TimelineItem["activity_type"]): string {
  if (activity === "lunch") return "午餐";
  if (activity === "dinner") return "晚餐";
  if (activity === "coffee") return "咖啡休息";
  return "推荐";
}

function rebuildStopFromPoi(
  original: TimelineItem,
  poi: AmapPoi,
): TimelineItem {
  const label = activityLabel(original.activity_type);
  return {
    ...original,
    title: `${label}：${poi.name}`,
    place_name: poi.name,
    place_id: poi.id,
    place_kind: "poi",
    lng: poi.coord.lng,
    lat: poi.coord.lat,
    amap_url: buildAmapMarkerUrl(poi.name, poi.coord),
    source: "amap",
    candidate_reliability: "confirmed",
    reason: poi.address
      ? `${poi.district || ""}${poi.district ? "・" : ""}${poi.address}`.trim()
      : `高德验证：${poi.name}`,
  };
}

interface ResolutionRewrite {
  /** Index in `newTimeline` of the resolved stop. The transport leg at
   *  `index - 1` (when present and of activity_type=transport) feeds this
   *  stop and should be rewritten to the new POI. We use index — not just
   *  name match — because two directional slots in the same plan can share
   *  the same `place_name`, in which case a name-only match would incorrectly
   *  rewrite both legs. */
  stopIndex: number;
  /** Original directional place_name as it appeared in the timeline. */
  oldName: string;
  /** New concrete POI place_name. */
  newName: string;
  /** New POI coord (used when patching transport legs). */
  coord: AmapCoord;
}

/** Apply Amap-resolved POIs to a single plan. Returns the patched plan. */
async function resolvePlan(
  plan: Plan,
  startCoord: AmapCoord | null,
  city: string,
  deps: AmapSearchDeps,
): Promise<{ plan: Plan; resolvedCount: number }> {
  const rewrites: ResolutionRewrite[] = [];
  const newTimeline: TimelineItem[] = [];

  // Track an anchor coord we can pass to nearby search. Initially the start
  // coord; updated as we walk past stops with known coords.
  let anchor: AmapCoord | null = startCoord;

  // Seed dedupe keys with whatever concrete stops the plan already has —
  // anything resolved upstream by enrichment / candidate replacement counts
  // as "already used" for directional resolution within this plan.
  const usedKeys = collectUsedKeys(plan.timeline, plan.timeline.length);

  for (const item of plan.timeline) {
    if (!isDirectionalStop(item)) {
      // Non-directional stops can update the anchor when they have coords.
      if (item.lng != null && item.lat != null) {
        anchor = { lng: item.lng, lat: item.lat };
      }
      newTimeline.push(item);
      continue;
    }

    const intent = extractDirectionalIntent(item);
    let poi: AmapPoi | null = null;
    try {
      poi = await resolveDirectionalStop(intent, anchor, city, deps, usedKeys);
    } catch (err) {
      console.warn("[directional-resolver] resolve failed for", item.place_name, err);
      poi = null;
    }
    if (!poi) {
      newTimeline.push(item);
      continue;
    }
    const rebuilt = rebuildStopFromPoi(item, poi);
    rewrites.push({
      stopIndex: newTimeline.length,
      oldName: item.place_name,
      newName: rebuilt.place_name,
      coord: poi.coord,
    });
    // Stamp the resolved POI into both keys-used and the rebuilt stop's
    // dedupe key so subsequent slots can't pick it again.
    usedKeys.add(poiDedupeKey(poi));
    const k = stopKey(rebuilt);
    if (k) usedKeys.add(k);
    anchor = poi.coord;
    newTimeline.push(rebuilt);
  }

  if (rewrites.length === 0) {
    return { plan, resolvedCount: 0 };
  }

  // Patch the transport leg that immediately precedes each resolved stop.
  // Walk the timeline a second time so we can also recompute route_options
  // using the resolved coord and the previous stop's coord.
  // Index-based: rewrite a transport leg only when the *next* timeline slot
  // is one of the stops we just resolved. This avoids the case where two
  // directional slots in the same plan share a place_name — a name-match
  // patch would rewrite both legs, even though only one was resolved.
  const rewriteByStopIndex = new Map<number, ResolutionRewrite>();
  for (const r of rewrites) rewriteByStopIndex.set(r.stopIndex, r);
  type StopCoord = { name: string; coord?: AmapCoord };
  let prev: StopCoord = { name: "", coord: startCoord ?? undefined };
  const patched: TimelineItem[] = [];
  for (let idx = 0; idx < newTimeline.length; idx++) {
    const it = newTimeline[idx];
    if (it.activity_type === "transport") {
      const rw = rewriteByStopIndex.get(idx + 1);
      if (rw) {
        const newCoord = rw.coord;
        const navUrl = prev.coord
          ? buildAmapNavigationUrl(prev.coord, newCoord, rw.newName)
          : buildAmapMarkerUrl(rw.newName, newCoord);
        patched.push({
          ...it,
          title: `前往${rw.newName}`,
          place_name: rw.newName,
          place_kind: "poi",
          lng: newCoord.lng,
          lat: newCoord.lat,
          amap_url: navUrl,
          route_options: buildRouteOptions(
            prev.name || "起点",
            rw.newName,
            prev.coord,
            newCoord,
          ),
        });
      } else {
        patched.push(it);
      }
      // Transport doesn't shift the anchor — that's done by the destination
      // stop on the next iteration.
      continue;
    }
    if (it.lng != null && it.lat != null) {
      prev = { name: it.place_name, coord: { lng: it.lng, lat: it.lat } };
    } else {
      prev = { name: it.place_name, coord: prev.coord };
    }
    patched.push(it);
  }

  // Patch route_chain similarly.
  const route_chain: RouteHop[] = plan.route_chain.map((hop) => {
    const fromR = rewrites.find((r) => r.oldName === hop.from);
    const toR = rewrites.find((r) => r.oldName === hop.to);
    if (!fromR && !toR) return hop;
    return {
      ...hop,
      from: fromR ? fromR.newName : hop.from,
      to: toR ? toR.newName : hop.to,
    };
  });

  return {
    plan: { ...plan, timeline: patched, route_chain },
    resolvedCount: rewrites.length,
  };
}

export interface DirectionalResolveOptions {
  /** Anchor coord near the start (typically the parsed start_location POI). */
  startCoord?: AmapCoord | null;
  /** City keyword passed to keyword search. Defaults to the constraint city. */
  city?: string;
  /** Injected Amap helpers, for tests. Defaults to the live client. */
  deps?: AmapSearchDeps;
}

export interface DirectionalResolveResult {
  response: PlanResponse;
  resolvedTotal: number;
}

/**
 * Walk every plan in `response`, attempt to resolve any directional
 * suggestion to a concrete Amap POI, and return the patched response.
 *
 * Behavior:
 * - Returns the input unchanged when AMAP_API_KEY is missing OR no `deps`
 *   override was supplied that bypasses the gate.
 * - Each plan is independent: a failure on one does not affect others.
 * - Directional stops that don't resolve are kept directional (no map link).
 *
 * Idempotent — once a stop has `place_kind === "poi"` it's no longer a
 * directional candidate and is skipped.
 */
export async function resolveDirectionalSuggestions(
  response: PlanResponse,
  opts: DirectionalResolveOptions = {},
): Promise<DirectionalResolveResult> {
  const deps = opts.deps || DEFAULT_DEPS;
  // When the caller hasn't supplied custom deps and Amap isn't configured,
  // we have no way to look anything up — bail out cheaply.
  const usingDefaultDeps = deps === DEFAULT_DEPS;
  if (usingDefaultDeps && !isAmapConfigured()) {
    return { response, resolvedTotal: 0 };
  }

  const city = opts.city || response.parsedConstraints.city || "上海";
  const startCoord = opts.startCoord ?? null;

  let resolvedTotal = 0;
  const newPlans: Plan[] = [];
  for (const plan of response.plans) {
    try {
      const r = await resolvePlan(plan, startCoord, city, deps);
      newPlans.push(r.plan);
      resolvedTotal += r.resolvedCount;
    } catch (err) {
      console.warn("[directional-resolver] plan failed, keeping original:", err);
      newPlans.push(plan);
    }
  }

  if (resolvedTotal === 0) {
    return { response, resolvedTotal: 0 };
  }

  const sources = new Set(response.dataSources.candidateSources || []);
  sources.add("amap");

  return {
    response: {
      ...response,
      plans: newPlans,
      dataSources: {
        ...response.dataSources,
        candidatesUsed: true,
        candidateSources: Array.from(sources),
      },
    },
    resolvedTotal,
  };
}
