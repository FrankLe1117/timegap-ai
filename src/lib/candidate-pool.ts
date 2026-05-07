/**
 * Candidate pool builder — pulls real-world POIs from Amap (and optionally
 * Meituan/Dianping when configured) and produces a category-keyed pool that
 * the planner can use to replace demo stops.
 *
 * Design notes:
 * - Server-only. Safe to import from API routes; never bundled into the client.
 * - Every helper bails out to an empty pool when AMAP_API_KEY is missing or the
 *   API call fails, so the demo path keeps working unchanged.
 * - The returned shape is intentionally narrow: we only carry what the planner
 *   needs to make a replacement decision (name, coords, category, score, source).
 */
import {
  AmapCoord,
  AmapPoi,
  isAmapConfigured,
  searchPoiByKeyword,
  searchPoiNearby,
} from "./amap-client";
import { Constraints } from "@/types";
import { searchMeituanDeals, isMeituanConfigured } from "./meituan-client";

export type CandidateCategory =
  | "restaurant"
  | "cafe"
  | "scenic"
  | "indoor"
  | "station_friendly";

export type CandidateSource = "amap" | "meituan";

/**
 * Reliability tier for a Candidate. Drives whether we're allowed to swap it
 * into the itinerary at all and how the UI labels it.
 *
 * - confirmed: real upstream POI id + non-empty address + category-matching
 *   type, name does not look synthetic, coord is plausible. Safe to surface
 *   as a concrete shop/attraction with "高德已验证".
 * - probable: has real upstream id and coord but is missing one of address /
 *   type / category match. May still be allowed for non-commercial slots
 *   (e.g. scenic/indoor), shown as "高德候选".
 * - suggested: weak — synthetic id (we generated `poi:<name>` because Amap
 *   omitted one), or generic-looking name, or category mismatch. Never
 *   replaces an itinerary stop.
 */
export type CandidateReliability = "confirmed" | "probable" | "suggested";

export interface Candidate {
  id: string;
  name: string;
  category: CandidateCategory;
  coord: AmapCoord;
  /** [0,1] heuristic score: higher = stronger match for the slot. */
  score: number;
  source: CandidateSource;
  /** Coarse city/district label for display when present. */
  district?: string;
  address?: string;
  /** Free-form tags (food preferences etc.) used for matching. */
  tags?: string[];
  /** Stable upstream POI id (e.g. Amap's `B0FFGPX001`). Empty string when we
   *  could not extract a real id from the response. */
  poi_id?: string;
  /** Raw Amap `type` field (semicolon-delimited path), preserved for gating. */
  raw_type?: string;
  /** Reliability tier — see `CandidateReliability` for semantics. */
  reliability: CandidateReliability;
  /** [0,1] confidence accumulated across the validation gates. */
  confidence: number;
  /** True when this candidate is allowed to actually replace a demo stop. */
  allow_in_itinerary: boolean;
}

export interface CandidatePool {
  byCategory: Record<CandidateCategory, Candidate[]>;
  /** True when at least one candidate originated from a real API. */
  hasRealData: boolean;
  /** Distinct sources represented. */
  sources: CandidateSource[];
}

const EMPTY_POOL: CandidatePool = {
  byCategory: {
    restaurant: [],
    cafe: [],
    scenic: [],
    indoor: [],
    station_friendly: [],
  },
  hasRealData: false,
  sources: [],
};

const FOOD_KEYWORD_HINTS: Record<string, string[]> = {
  local_food: ["本帮菜", "上海菜", "小笼", "生煎"],
  shanghainese: ["本帮菜", "上海老味道"],
  vegetarian: ["素食"],
  spicy: ["川菜", "湘菜"],
  light: ["简餐", "轻食"],
  dessert: ["甜品", "蛋糕"],
};

function dedupe(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of list) {
    const k = `${c.name}|${c.coord.lng.toFixed(4)},${c.coord.lat.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * Reliability gates. Each helper returns true when the candidate passes the
 * check. They are intentionally conservative: when in doubt we downgrade
 * rather than allow a synthetic-looking POI into the itinerary.
 */

/**
 * Category-type matching keywords. We lookup against the raw Amap `type`
 * (typically a semicolon-delimited path like "餐饮服务;中餐厅;本帮江浙菜")
 * lowercased so we can cheaply substring-match. A category is considered to
 * match when at least one of its keywords appears in the type string.
 */
const CATEGORY_TYPE_KEYWORDS: Record<CandidateCategory, string[]> = {
  restaurant: ["餐饮", "美食", "餐厅", "中餐", "西餐", "本帮", "小吃", "restaurant", "food"],
  cafe: ["咖啡", "饮品", "茶饮", "甜品", "cafe", "coffee", "tea"],
  scenic: ["风景", "景点", "公园", "广场", "park", "scenic", "tourist", "attraction"],
  indoor: ["博物", "美术", "展览", "购物", "商场", "文化", "museum", "mall", "shopping", "gallery"],
  station_friendly: ["餐饮", "美食", "餐厅", "中餐", "西餐", "小吃", "restaurant", "food"],
};

/** Categories whose distance gate to the start anchor (km). */
const CATEGORY_MAX_KM_FROM_START: Record<CandidateCategory, number> = {
  restaurant: 5,
  cafe: 5,
  scenic: 5,
  indoor: 5,
  station_friendly: 12,
};

/** Categories whose distance gate to the destination anchor (km). */
const CATEGORY_MAX_KM_FROM_DEST: Partial<Record<CandidateCategory, number>> = {
  station_friendly: 4,
};

/**
 * Detect names that look synthetic — short, "<something>本帮/小馆/餐厅/咖啡/景点"
 * or names that are exactly the area + a generic dish word. Such names are
 * the classic shape of a hallucinated POI ("徐家汇本帮小馆") and must not be
 * surfaced as a concrete shop unless every other gate passes.
 */
const GENERIC_TAIL_PATTERNS: RegExp[] = [
  /^.{0,8}(本帮|小馆|餐厅|餐馆|饭馆|食堂|酒楼|咖啡店?|咖啡馆|景点|景区|公园|博物馆|美术馆)$/u,
  /^(本帮|小馆|餐厅|咖啡|景点|公园)$/u,
];

/** Tokens that look like preference keywords (would be a copy-paste of input). */
const PREFERENCE_KEYWORDS = new Set([
  "本帮菜",
  "上海菜",
  "咖啡",
  "甜品",
  "素食",
  "川菜",
  "湘菜",
  "简餐",
  "轻食",
  "景点",
]);

function nameLooksSynthetic(name: string): boolean {
  const n = (name || "").trim();
  if (!n) return true;
  if (PREFERENCE_KEYWORDS.has(n)) return true;
  return GENERIC_TAIL_PATTERNS.some((re) => re.test(n));
}

function coordIsValid(coord: AmapCoord | undefined | null): coord is AmapCoord {
  if (!coord) return false;
  const { lng, lat } = coord;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  // Loose mainland-China bounding box; rejects (0,0) and obvious garbage.
  if (lng < 73 || lng > 136) return false;
  if (lat < 17 || lat > 54) return false;
  return true;
}

function categoryTypeMatches(category: CandidateCategory, rawType?: string): boolean {
  if (!rawType) return false;
  const t = rawType.toLowerCase();
  return CATEGORY_TYPE_KEYWORDS[category].some((kw) => t.includes(kw.toLowerCase()));
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

interface AnchorOpts {
  startCoord?: AmapCoord | null;
  destCoord?: AmapCoord | null;
}

/**
 * Compute reliability tier + numeric confidence + allow flag for a POI.
 *
 * Each gate contributes a small confidence delta:
 * - real upstream POI id: +0.30 (mandatory for confirmed)
 * - non-empty address:    +0.20
 * - category type match:  +0.20
 * - non-synthetic name:   +0.15 (mandatory for confirmed)
 * - valid coord + within distance gate: +0.15
 *
 * Tier mapping: confidence >= 0.80 AND has real id AND non-synthetic name
 * AND coord-valid → confirmed; >= 0.50 → probable; otherwise suggested.
 *
 * `allow_in_itinerary` is true only for confirmed (any category) or probable
 * non-commercial slots (scenic/indoor) where coords are real.
 */
function classifyReliability(
  poi: AmapPoi,
  category: CandidateCategory,
  anchors: AnchorOpts,
): { reliability: CandidateReliability; confidence: number; allow_in_itinerary: boolean } {
  const hasRealId = !!poi.hasRealId && !poi.id.startsWith("poi:") && !poi.id.startsWith("geo:");
  const hasAddress = !!poi.address && poi.address.trim().length > 0;
  const typeMatches = categoryTypeMatches(category, poi.type);
  const nonSynthetic = !nameLooksSynthetic(poi.name);
  const coordOk = coordIsValid(poi.coord);

  let distanceOk = true;
  if (coordOk) {
    if (anchors.startCoord) {
      const km = kmBetween(anchors.startCoord, poi.coord);
      const limit = CATEGORY_MAX_KM_FROM_START[category];
      if (km > limit) distanceOk = false;
    }
    if (distanceOk && anchors.destCoord) {
      const destLimit = CATEGORY_MAX_KM_FROM_DEST[category];
      if (destLimit != null) {
        const km = kmBetween(anchors.destCoord, poi.coord);
        if (km > destLimit) distanceOk = false;
      }
    }
  } else {
    distanceOk = false;
  }

  let conf = 0;
  if (hasRealId) conf += 0.3;
  if (hasAddress) conf += 0.2;
  if (typeMatches) conf += 0.2;
  if (nonSynthetic) conf += 0.15;
  if (coordOk && distanceOk) conf += 0.15;
  conf = Math.max(0, Math.min(1, conf));

  let reliability: CandidateReliability;
  if (hasRealId && nonSynthetic && coordOk && distanceOk && conf >= 0.8) {
    reliability = "confirmed";
  } else if (hasRealId && nonSynthetic && coordOk && distanceOk && conf >= 0.5) {
    reliability = "probable";
  } else {
    reliability = "suggested";
  }

  // Replacement allowance:
  // - confirmed → always allowed.
  // - probable → only allowed for scenic/indoor (non-commercial), where a
  //   missing address/type is much less misleading than for a restaurant.
  // - suggested → never allowed.
  const allow_in_itinerary =
    reliability === "confirmed" ||
    (reliability === "probable" && (category === "scenic" || category === "indoor"));

  return { reliability, confidence: conf, allow_in_itinerary };
}

function poiToCandidate(
  poi: AmapPoi,
  category: CandidateCategory,
  baseScore: number,
  source: CandidateSource,
  anchors: AnchorOpts,
): Candidate {
  const { reliability, confidence, allow_in_itinerary } = classifyReliability(
    poi,
    category,
    anchors,
  );
  // Penalize the heuristic score by confidence so unreliable candidates can
  // never out-rank a confirmed one of the same category.
  const score = Math.max(0, Math.min(1, baseScore)) * (0.6 + confidence * 0.4);
  return {
    id: `${source}:${poi.id}`,
    name: poi.name,
    category,
    coord: poi.coord,
    score,
    source,
    district: poi.district,
    address: poi.address,
    tags: poi.type ? poi.type.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [],
    poi_id: poi.hasRealId ? poi.id : undefined,
    raw_type: poi.type,
    reliability,
    confidence,
    allow_in_itinerary,
  };
}

function preferenceFoodKeywords(constraints: Constraints): string[] {
  const out = new Set<string>();
  for (const p of constraints.preferences) {
    const hints = FOOD_KEYWORD_HINTS[p];
    if (hints) hints.forEach((h) => out.add(h));
  }
  for (const f of constraints.food_preference || []) {
    const hints = FOOD_KEYWORD_HINTS[f];
    if (hints) hints.forEach((h) => out.add(h));
    else out.add(f);
  }
  if (out.size === 0) out.add("本帮菜");
  return Array.from(out).slice(0, 3);
}

function rankPois(pois: AmapPoi[], preferred: AmapCoord | null): AmapPoi[] {
  if (!preferred) return pois;
  const dist = (p: AmapPoi) => {
    const dx = p.coord.lng - preferred.lng;
    const dy = p.coord.lat - preferred.lat;
    return dx * dx + dy * dy;
  };
  return [...pois].sort((a, b) => dist(a) - dist(b));
}

interface BuildOptions {
  /** Anchor near the start (for in-itinerary stops). */
  startCoord?: AmapCoord | null;
  /** Anchor near the destination (for station_friendly fallback meals). */
  destCoord?: AmapCoord | null;
  /** Max candidates per category. */
  perCategoryLimit?: number;
}

/**
 * Build a candidate pool covering the categories the planner will swap in.
 * Returns an empty pool when the Amap key is missing or every search fails.
 */
export async function buildCandidatePool(
  constraints: Constraints,
  opts: BuildOptions = {},
): Promise<CandidatePool> {
  if (!isAmapConfigured()) return EMPTY_POOL;

  const limit = opts.perCategoryLimit ?? 6;
  const city = constraints.city || "上海";
  const start = opts.startCoord || null;
  const dest = opts.destCoord || null;

  const foodKws = preferenceFoodKeywords(constraints);

  // Run searches in parallel. Each helper already returns [] on failure.
  const [
    restaurantPoisByKw,
    cafePois,
    scenicPois,
    indoorPois,
    stationRestaurantPois,
  ] = await Promise.all([
    Promise.all(
      foodKws.map((kw) =>
        start
          ? searchPoiNearby(start, kw, 2500, limit)
          : searchPoiByKeyword(kw, city, limit),
      ),
    ),
    start
      ? searchPoiNearby(start, "咖啡", 1500, limit)
      : searchPoiByKeyword("咖啡", city, limit),
    start
      ? searchPoiNearby(start, "公园 景点", 3000, limit)
      : searchPoiByKeyword("景点", city, limit),
    start
      ? searchPoiNearby(start, "博物馆 商场", 3000, limit)
      : searchPoiByKeyword("博物馆", city, limit),
    dest
      ? searchPoiNearby(dest, "餐厅", 2000, limit)
      : Promise.resolve([] as AmapPoi[]),
  ]);

  const anchors: AnchorOpts = { startCoord: start, destCoord: dest };

  // Optional Meituan layer — currently a no-op until credentials are set.
  let meituanRestaurants: Candidate[] = [];
  if (isMeituanConfigured()) {
    try {
      const deals = await searchMeituanDeals({
        keyword: foodKws[0] || "本帮菜",
        coord: start || null,
        city,
      });
      meituanRestaurants = deals.map((d, i) =>
        poiToCandidate(
          {
            id: d.id,
            name: d.name,
            coord: d.coord,
            address: d.address,
            district: d.district,
            type: "餐饮服务",
            hasRealId: !!d.id,
          },
          "restaurant",
          0.7 - i * 0.03,
          "meituan",
          anchors,
        ),
      );
    } catch {
      meituanRestaurants = [];
    }
  }

  const restaurantsRaw = restaurantPoisByKw
    .flat()
    .map((p, i) => poiToCandidate(p, "restaurant", 0.85 - i * 0.02, "amap", anchors));
  const restaurants = dedupe([...restaurantsRaw, ...meituanRestaurants]);

  const cafes = dedupe(
    rankPois(cafePois, start).map((p, i) =>
      poiToCandidate(p, "cafe", 0.8 - i * 0.04, "amap", anchors),
    ),
  );
  const scenic = dedupe(
    rankPois(scenicPois, start).map((p, i) =>
      poiToCandidate(p, "scenic", 0.75 - i * 0.04, "amap", anchors),
    ),
  );
  const indoor = dedupe(
    rankPois(indoorPois, start).map((p, i) =>
      poiToCandidate(p, "indoor", 0.7 - i * 0.04, "amap", anchors),
    ),
  );
  const stationFriendly = dedupe(
    rankPois(stationRestaurantPois, dest).map((p, i) =>
      poiToCandidate(p, "station_friendly", 0.85 - i * 0.04, "amap", anchors),
    ),
  );

  const byCategory = {
    restaurant: restaurants.slice(0, limit),
    cafe: cafes.slice(0, limit),
    scenic: scenic.slice(0, limit),
    indoor: indoor.slice(0, limit),
    station_friendly: stationFriendly.slice(0, limit),
  };

  const totalReal = Object.values(byCategory).reduce((n, list) => n + list.length, 0);
  const sources: CandidateSource[] = [];
  if (Object.values(byCategory).some((list) => list.some((c) => c.source === "amap"))) sources.push("amap");
  if (Object.values(byCategory).some((list) => list.some((c) => c.source === "meituan"))) sources.push("meituan");

  return {
    byCategory,
    hasRealData: totalReal > 0,
    sources,
  };
}

export function isPoolUsable(pool: CandidatePool): boolean {
  if (!pool.hasRealData) return false;
  // Need at least one of: a restaurant or a scenic to be useful for replacement.
  return pool.byCategory.restaurant.length > 0 || pool.byCategory.scenic.length > 0;
}
