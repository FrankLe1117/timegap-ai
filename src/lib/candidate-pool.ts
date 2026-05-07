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

function poiToCandidate(
  poi: AmapPoi,
  category: CandidateCategory,
  baseScore: number,
  source: CandidateSource,
): Candidate {
  return {
    id: `${source}:${poi.id}`,
    name: poi.name,
    category,
    coord: poi.coord,
    score: Math.max(0, Math.min(1, baseScore)),
    source,
    district: poi.district,
    address: poi.address,
    tags: poi.type ? poi.type.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [],
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
          { id: d.id, name: d.name, coord: d.coord, address: d.address, district: d.district },
          "restaurant",
          0.7 - i * 0.03,
          "meituan",
        ),
      );
    } catch {
      meituanRestaurants = [];
    }
  }

  const restaurantsRaw = restaurantPoisByKw
    .flat()
    .map((p, i) => poiToCandidate(p, "restaurant", 0.85 - i * 0.02, "amap"));
  const restaurants = dedupe([...restaurantsRaw, ...meituanRestaurants]);

  const cafes = dedupe(
    rankPois(cafePois, start).map((p, i) => poiToCandidate(p, "cafe", 0.8 - i * 0.04, "amap")),
  );
  const scenic = dedupe(
    rankPois(scenicPois, start).map((p, i) => poiToCandidate(p, "scenic", 0.75 - i * 0.04, "amap")),
  );
  const indoor = dedupe(
    rankPois(indoorPois, start).map((p, i) => poiToCandidate(p, "indoor", 0.7 - i * 0.04, "amap")),
  );
  const stationFriendly = dedupe(
    rankPois(stationRestaurantPois, dest).map((p, i) =>
      poiToCandidate(p, "station_friendly", 0.85 - i * 0.04, "amap"),
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
