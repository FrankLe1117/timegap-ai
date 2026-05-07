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
import { collectUsedKeys, convertStopToDirectional, stopKey } from "./plan-dedupe";

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
  { re: /日料|日本料理/, category: "日料" },
  { re: /茶餐厅|港式/, category: "茶餐厅" },
  { re: /咖啡/, category: "咖啡" },
  { re: /茶馆?/, category: "茶馆" },
  { re: /小吃|快餐|简餐/, category: "本地小吃" },
  { re: /餐厅|小馆|餐馆|饭馆|食堂|酒楼|小酒馆|酒馆/, category: "餐厅" },
];

/**
 * Generalization ladder for cuisine categories. Each key maps to broader
 * synonyms ordered by specificity. Used by the cascade to widen searches when
 * a precise cuisine returns nothing reliable — e.g. 本帮菜 → 上海菜 → 江浙菜
 * → 中餐. Empty array means "no further generalization beyond the bare
 * category".
 */
const CUISINE_GENERALIZATION: Record<string, string[]> = {
  本帮菜: ["上海菜", "江浙菜", "中餐"],
  老字号餐厅: ["中餐", "本帮菜", "上海菜"],
  法餐: ["西餐", "法国菜"],
  日料: ["日本料理", "亚洲菜"],
  茶餐厅: ["粤菜", "港式茶餐厅", "中餐"],
  茶馆: ["茶艺馆", "茶饮"],
  咖啡: ["咖啡馆", "咖啡厅"],
  本地小吃: ["小吃", "快餐", "简餐"],
  餐厅: ["美食"],
};

/** Generic terminal categories per activity. The cascade falls back to these
 *  when even the generalized cuisine returns nothing usable. */
const GENERIC_CATEGORIES: Record<string, string[]> = {
  lunch: ["餐厅", "美食", "中餐厅", "小馆"],
  dinner: ["餐厅", "美食", "中餐厅", "小馆"],
  coffee: ["咖啡馆", "咖啡厅", "饮品", "茶饮"],
};

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
 * Build a broader set of meal-specific Amap queries used as a fallback when
 * the intent-derived queries return nothing reliable. These widen the search
 * along two axes:
 *   - Use the user's food preferences / additional cuisines (本帮菜, 茶餐厅, …)
 *     even when the directional name didn't carry that category token.
 *   - Use generic restaurant tokens (餐厅, 小馆) on top of any area we have.
 *
 * Caller passes additional cuisine hints (e.g. parsed from constraints or
 * timeline tags). Always returns at least one query.
 *
 * Returned order is the flat union of all cascade levels (level 1 first, then
 * level 2, …), de-duped. Used as a single-pass fallback in older callers and
 * by the cascade itself for level-2 wide search.
 */
export function buildMealFallbackQueries(
  intent: DirectionalIntent,
  cuisineHints: string[] = [],
): string[] {
  const levels = buildMealCascadeLevels(intent, cuisineHints);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const lvl of levels) {
    for (const q of lvl) {
      if (!seen.has(q)) {
        seen.add(q);
        out.push(q);
      }
    }
  }
  // Cap to keep network volume bounded; the cascade itself runs the full
  // ladder via buildMealCascadeLevels.
  return out.slice(0, 12);
}

/**
 * Build the cascading query ladder for meal/coffee directional resolution.
 *
 * Each returned array is one cascade level — Amap is searched once per query
 * per level until a reliable POI shows up, then we stop. Levels widen the net:
 *
 *   L1  exact intent + area:           "人民广场 本帮菜", "人民广场 餐厅"
 *   L2  generalized cuisine + area:    "人民广场 上海菜", "人民广场 江浙菜",
 *                                      "人民广场 中餐"
 *   L3  generic category + area:       "人民广场 餐厅", "人民广场 美食"
 *   L4  cuisine-only (no area):        "本帮菜", "上海菜", "中餐"
 *   L5  generic category (no area):    "餐厅", "美食", "小馆"
 *
 * Coffee directionals follow the same shape but with cafe-specific tokens.
 *
 * The ladder is bounded: each level returns at most ~6 queries, and the
 * resolver short-circuits as soon as one query yields a reliable hit.
 */
export function buildMealCascadeLevels(
  intent: DirectionalIntent,
  cuisineHints: string[] = [],
): string[][] {
  const a = intent.area || "";
  const isCoffee = intent.activity === "coffee";

  // Collect cuisine tokens. Order matters: intent's own category first, then
  // user-provided hints, then anything that came from generalizing those.
  const baseCuisines: string[] = [];
  const seenCuisine = new Set<string>();
  const addCuisine = (c: string | undefined | null) => {
    if (!c) return;
    const t = c.trim();
    if (!t || t === "餐厅" || seenCuisine.has(t)) return;
    seenCuisine.add(t);
    baseCuisines.push(t);
  };
  addCuisine(intent.category);
  for (const h of cuisineHints) addCuisine(h);

  // Generalized synonyms for everything we collected so far.
  const generalized: string[] = [];
  const seenGen = new Set<string>(seenCuisine);
  for (const c of [...baseCuisines]) {
    const syns = CUISINE_GENERALIZATION[c] || [];
    for (const s of syns) {
      if (!seenGen.has(s)) {
        seenGen.add(s);
        generalized.push(s);
      }
    }
  }

  const generic = GENERIC_CATEGORIES[intent.activity] || ["餐厅", "美食"];

  const dedup = (arr: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of arr) {
      const t = x.trim().replace(/\s+/g, " ");
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  };

  const withArea = (toks: string[]): string[] =>
    a ? toks.map((t) => `${a} ${t}`) : [];

  // Level 1: exact intent (cuisine + area). Mirrors buildIntentQueries' first
  // shot but without the bare-cuisine tail (the bare query lives in L4).
  const l1 = dedup([
    ...withArea(baseCuisines),
    // Always at least one "<area> 餐厅"/"<area> 咖啡馆" query so we have a
    // sensible category-with-area variant even when the directional name only
    // carried a vague hint.
    ...withArea(isCoffee ? ["咖啡馆"] : ["餐厅"]),
  ]);

  // Level 2: generalized cuisine + area.
  const l2 = dedup(withArea(generalized));

  // Level 3: generic category + area.
  const l3 = dedup(withArea(generic));

  // Level 4: cuisine-only (no area). Even without geographic biasing this can
  // land a famous chain that we can clamp to anchor distance later.
  const l4 = dedup([...baseCuisines, ...generalized]);

  // Level 5: generic category (no area) — terminal fallback.
  const l5 = dedup(generic);

  return [l1, l2, l3, l4, l5].filter((lvl) => lvl.length > 0);
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
  if (nameLooksSynthetic(poi.name)) return false;
  if (!coordIsValid(poi.coord)) return false;

  // Type/category gating is the primary signal — Amap's place/around endpoint
  // routinely omits `address` for legitimate restaurants, so we no longer
  // hard-require it. We DO still require a category match against the
  // activity bucket so we don't accept a museum POI for a dinner slot.
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
 * Per-level Amap search budget for the cascade. Earlier levels search a tight
 * radius for tightly-targeted queries; later levels widen the net so we still
 * have a shot at finding *something* before falling back to manual confirm.
 *
 * `radiusMeters` is passed to `searchPoiNearby`; `limit` to both nearby and
 * keyword searches.
 */
interface CascadeLevelBudget {
  radiusMeters: number;
  limit: number;
}

const MEAL_CASCADE_BUDGETS: CascadeLevelBudget[] = [
  { radiusMeters: 2500, limit: 5 },   // L1 exact: tight + small
  { radiusMeters: 3500, limit: 8 },   // L2 generalized cuisine
  { radiusMeters: 4000, limit: 10 },  // L3 generic + area
  { radiusMeters: 6000, limit: 15 },  // L4 cuisine-only, no area
  { radiusMeters: 8000, limit: 20 },  // L5 generic, no area: terminal
];

/**
 * Try to resolve a single directional stop. Runs a cascading ladder of Amap
 * queries that progressively widen — first the intent-derived precise query,
 * then meal-specific generalizations and generic categories — and returns the
 * first reliable POI, or null when every level fails the gate.
 *
 * `anchor` is the most recent coord we know (start point or the previous
 * stop) — used both to constrain `searchPoiNearby` and to gate distance.
 *
 * Cascade structure (meal/coffee directionals):
 *   L0  intent queries (cuisine + area, exact)            — radius 2.5km
 *   L1  generalized cuisine + area                         — radius 3.5km
 *   L2  generic category + area                            — radius 4km
 *   L3  cuisine-only (no area)                             — radius 6km
 *   L4  generic category (no area), terminal               — radius 8km
 *
 * Non-meal directionals (e.g. attraction) only run L0; broader generalization
 * doesn't make sense without category supervision.
 */
export async function resolveDirectionalStop(
  intent: DirectionalIntent,
  anchor: AmapCoord | null,
  city = "上海",
  deps: AmapSearchDeps = DEFAULT_DEPS,
  usedKeys?: Set<string>,
  options: { cuisineHints?: string[] } = {},
): Promise<AmapPoi | null> {
  // Level 0: intent-derived queries with the standard 2.5 km radius.
  const l0Queries = buildIntentQueries(intent);
  const l0Budget = MEAL_CASCADE_BUDGETS[0];
  for (const q of l0Queries) {
    const pick = await runCascadeQuery(q, intent, anchor, city, l0Budget, deps, usedKeys);
    if (pick) return pick;
  }

  const isMeal =
    intent.activity === "lunch" ||
    intent.activity === "dinner" ||
    intent.activity === "coffee";
  if (!isMeal) return null;

  // Levels 1..4: meal/coffee cascade.
  const cascade = buildMealCascadeLevels(intent, options.cuisineHints || []);
  for (let i = 0; i < cascade.length; i++) {
    const queries = cascade[i];
    const budget = MEAL_CASCADE_BUDGETS[Math.min(i + 1, MEAL_CASCADE_BUDGETS.length - 1)];
    for (const q of queries) {
      const pick = await runCascadeQuery(q, intent, anchor, city, budget, deps, usedKeys);
      if (pick) return pick;
    }
  }
  return null;
}

/**
 * Single cascade query: nearby first (when anchor is available) at the level's
 * radius/limit, then keyword fallback at the same limit. Returns the first POI
 * that passes the reliability gate AND isn't already in `usedKeys`.
 */
async function runCascadeQuery(
  query: string,
  intent: DirectionalIntent,
  anchor: AmapCoord | null,
  city: string,
  budget: CascadeLevelBudget,
  deps: AmapSearchDeps,
  usedKeys: Set<string> | undefined,
): Promise<AmapPoi | null> {
  let pois: AmapPoi[] = [];
  if (anchor) {
    pois = await deps.searchNearby(anchor, query, budget.radiusMeters, budget.limit);
  }
  if (!pois.length) {
    pois = await deps.searchByKeyword(query, city, budget.limit);
  }
  return pickReliable(pois, intent.activity, anchor, usedKeys);
}

/**
 * Find a replacement restaurant/cafe POI for a meal stop given an anchor
 * coordinate, the activity bucket, and a set of dedupe keys to avoid.
 *
 * This is the entry point used by the duplicate-repair pass: when a plan ends
 * up with two stops at the same POI, it asks Amap for a different but still
 * reliable nearby restaurant before falling back to a directional placeholder.
 *
 * Reuses the same intent-derived + meal-fallback query ladder as
 * `resolveDirectionalStop`, plus the same reliability gate, so the result —
 * if any — is guaranteed to be navigable AND distinct from the existing
 * concrete stops.
 */
export async function resolveMealReplacement(args: {
  activity: TimelineItem["activity_type"];
  anchor: AmapCoord | null;
  area?: string;
  category?: string;
  city?: string;
  cuisineHints?: string[];
  usedKeys: Set<string>;
  deps?: AmapSearchDeps;
}): Promise<AmapPoi | null> {
  const intent: DirectionalIntent = {
    area: args.area,
    category:
      args.category || (args.activity === "coffee" ? "咖啡" : "餐厅"),
    activity: args.activity,
  };
  const deps = args.deps || DEFAULT_DEPS;
  return resolveDirectionalStop(
    intent,
    args.anchor,
    args.city || "上海",
    deps,
    args.usedKeys,
    { cuisineHints: args.cuisineHints || [] },
  );
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

/** Index of an unresolved meal/coffee directional that we converted to a
 *  manual-confirm placeholder. Used to patch the transport leg that feeds it. */
interface ManualConfirmRewrite {
  stopIndex: number;
  oldName: string;
  newName: string;
}

/** Apply Amap-resolved POIs to a single plan. Returns the patched plan. */
async function resolvePlan(
  plan: Plan,
  startCoord: AmapCoord | null,
  city: string,
  deps: AmapSearchDeps,
  cuisineHints: string[] = [],
): Promise<{ plan: Plan; resolvedCount: number; manualConfirmCount: number }> {
  const rewrites: ResolutionRewrite[] = [];
  const manualRewrites: ManualConfirmRewrite[] = [];
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
      poi = await resolveDirectionalStop(intent, anchor, city, deps, usedKeys, {
        cuisineHints,
      });
    } catch (err) {
      console.warn("[directional-resolver] resolve failed for", item.place_name, err);
      poi = null;
    }
    if (!poi) {
      // No reliable POI found. For meal/coffee directionals, when Amap is
      // reachable (we just queried it), upgrade the placeholder to the
      // actionable "需要手动确认餐馆/咖啡馆" wording AND, when we have any
      // city/area/cuisine hints to build a search keyword, attach an Amap
      // search URL so the user has a real way to pick a place themselves.
      const isMeal =
        item.activity_type === "lunch" ||
        item.activity_type === "dinner" ||
        item.activity_type === "coffee";
      if (isMeal) {
        const oldName = item.place_name;
        // Prefer a precise cuisine for the search keyword: the directional
        // intent's category if specific, then any user-supplied hint, then
        // bare "餐厅"/"咖啡馆".
        const isCoffee = item.activity_type === "coffee";
        const baseCategory = isCoffee ? "咖啡馆" : "餐厅";
        const intentCuisine =
          intent.category && intent.category !== "餐厅" && intent.category !== baseCategory
            ? intent.category
            : "";
        const cuisine = intentCuisine || cuisineHints[0] || "";
        const manual = convertStopToDirectional(item, {
          mealManualConfirm: true,
          searchHints: {
            city,
            area: intent.area,
            cuisine: cuisine || undefined,
          },
        });
        manualRewrites.push({
          stopIndex: newTimeline.length,
          oldName,
          newName: manual.place_name,
        });
        newTimeline.push(manual);
      } else {
        newTimeline.push(item);
      }
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

  if (rewrites.length === 0 && manualRewrites.length === 0) {
    return { plan, resolvedCount: 0, manualConfirmCount: 0 };
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
  const manualByStopIndex = new Map<number, ManualConfirmRewrite>();
  for (const r of manualRewrites) manualByStopIndex.set(r.stopIndex, r);
  type StopCoord = { name: string; coord?: AmapCoord };
  let prev: StopCoord = { name: "", coord: startCoord ?? undefined };
  const patched: TimelineItem[] = [];
  for (let idx = 0; idx < newTimeline.length; idx++) {
    const it = newTimeline[idx];
    if (it.activity_type === "transport") {
      const rw = rewriteByStopIndex.get(idx + 1);
      const mw = manualByStopIndex.get(idx + 1);
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
      } else if (mw) {
        // Transport leg now feeds a manual-confirm placeholder. Strip every
        // verified-POI affordance — but if the placeholder carries an Amap
        // search URL, surface it as a single search-mode chip on the leg so
        // the user can open the same search from the transport step too.
        // Mode "search" keeps the UI honest: it must NOT be styled like a
        // verified driving/transit route to a concrete place.
        const target = newTimeline[mw.stopIndex];
        const isSearch = target?.place_kind === "search" && !!target.search_url;
        patched.push({
          ...it,
          title: `前往${mw.newName}`,
          place_name: mw.newName,
          place_kind: isSearch ? "search" : "directional",
          place_id: undefined,
          lng: undefined,
          lat: undefined,
          amap_url: undefined,
          search_url: isSearch ? target.search_url : undefined,
          search_query: isSearch ? target.search_query : undefined,
          route_options: isSearch
            ? [
                {
                  mode: "search" as const,
                  label: "在高德搜索路线",
                  url: target.search_url!,
                },
              ]
            : undefined,
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

  // Patch route_chain similarly. Both POI replacements and manual-confirm
  // rewrites need their old place_name updated so chain stays consistent.
  const renameByOld = new Map<string, string>();
  for (const r of rewrites) renameByOld.set(r.oldName, r.newName);
  for (const r of manualRewrites) renameByOld.set(r.oldName, r.newName);
  const route_chain: RouteHop[] = plan.route_chain.map((hop) => {
    const fromR = renameByOld.get(hop.from);
    const toR = renameByOld.get(hop.to);
    if (!fromR && !toR) return hop;
    return {
      ...hop,
      from: fromR ? fromR : hop.from,
      to: toR ? toR : hop.to,
    };
  });

  return {
    plan: { ...plan, timeline: patched, route_chain },
    resolvedCount: rewrites.length,
    manualConfirmCount: manualRewrites.length,
  };
}

export interface DirectionalResolveOptions {
  /** Anchor coord near the start (typically the parsed start_location POI). */
  startCoord?: AmapCoord | null;
  /** City keyword passed to keyword search. Defaults to the constraint city. */
  city?: string;
  /** Injected Amap helpers, for tests. Defaults to the live client. */
  deps?: AmapSearchDeps;
  /** Extra cuisine/food hints (e.g. parsed `food_preference`). Used to widen
   *  the meal fallback search beyond the category extracted from the
   *  directional name. */
  cuisineHints?: string[];
}

export interface DirectionalResolveResult {
  response: PlanResponse;
  resolvedTotal: number;
  /** Count of meal/coffee directionals that Amap could not resolve and were
   *  upgraded to the explicit "需要手动确认餐馆/咖啡馆" placeholder. */
  manualConfirmTotal: number;
}

/**
 * Walk every plan in `response`, attempt to resolve any directional
 * suggestion to a concrete Amap POI, and return the patched response.
 *
 * Behavior:
 * - Returns the input unchanged when AMAP_API_KEY is missing OR no `deps`
 *   override was supplied that bypasses the gate.
 * - Each plan is independent: a failure on one does not affect others.
 * - Directional meal/coffee stops that don't resolve are upgraded to a clear
 *   "需要手动确认餐馆/咖啡馆" manual-confirm placeholder (since Amap was
 *   reachable — we just queried it). This avoids leaving the user with the
 *   generic "找一家本帮菜小馆" suggestion text. Non-meal directionals are
 *   left as-is.
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
    return { response, resolvedTotal: 0, manualConfirmTotal: 0 };
  }

  const city = opts.city || response.parsedConstraints.city || "上海";
  const startCoord = opts.startCoord ?? null;
  const cuisineHints = Array.from(
    new Set([
      ...(opts.cuisineHints || []),
      ...((response.parsedConstraints.food_preference || []) as string[]),
    ]),
  ).filter((s) => typeof s === "string" && s.trim().length > 0);

  let resolvedTotal = 0;
  let manualConfirmTotal = 0;
  const newPlans: Plan[] = [];
  for (const plan of response.plans) {
    try {
      const r = await resolvePlan(plan, startCoord, city, deps, cuisineHints);
      newPlans.push(r.plan);
      resolvedTotal += r.resolvedCount;
      manualConfirmTotal += r.manualConfirmCount;
    } catch (err) {
      console.warn("[directional-resolver] plan failed, keeping original:", err);
      newPlans.push(plan);
    }
  }

  if (resolvedTotal === 0 && manualConfirmTotal === 0) {
    return { response, resolvedTotal: 0, manualConfirmTotal: 0 };
  }

  // Only flip dataSources when we actually used Amap to confirm a POI. A pure
  // manual-confirm pass means Amap was queried but produced nothing usable —
  // not the same as "amap candidates landed in the plan".
  let next: PlanResponse = { ...response, plans: newPlans };
  if (resolvedTotal > 0) {
    const sources = new Set(response.dataSources.candidateSources || []);
    sources.add("amap");
    next = {
      ...next,
      dataSources: {
        ...response.dataSources,
        candidatesUsed: true,
        candidateSources: Array.from(sources),
      },
    };
  }

  return {
    response: next,
    resolvedTotal,
    manualConfirmTotal,
  };
}
