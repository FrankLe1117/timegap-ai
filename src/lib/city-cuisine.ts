/**
 * City-aware cuisine + branding helpers.
 *
 * Why this exists: the original candidate pool defaulted to 本帮菜/上海菜 as the
 * Amap search keyword for every city when the user said "更本地"/"local_food".
 * In Guangzhou that pulled in Shanghai-branded chains (沪上阿姨, 沪上鲜师傅, …)
 * because Amap honestly indexes them in 广州. This module owns the city-aware
 * logic so callers (constraint-parser, candidate-pool, directional-resolver,
 * ranking) all agree on:
 *
 *   - localCuisinesFor(profileKey)        — preferred local cuisines per city.
 *   - generalizeCuisine(cuisine, profile) — cascade fallback (本帮菜 → 上海菜
 *                                          → 江浙菜 → 中餐) without crossing
 *                                          city boundaries unless asked.
 *   - foreignBrandPenalty(name, profile)  — score penalty for an obviously
 *                                          out-of-city brand (e.g. "沪上"
 *                                          prefix in Guangzhou).
 *   - cuisineBoost(name, type, profile)   — score boost for POIs that look
 *                                          like the local cuisine.
 *
 * The mapping is intentionally small but extensible. Unknown cities fall back
 * to a generic "本地特色"/"餐厅" hint so we never inject Shanghai cuisine.
 */
import type { CityKey } from "./city-detect";

/**
 * Tokens that strongly imply Shanghai cuisine/brand. Used both as a keyword
 * for the Shanghai branch AND as a "foreign brand" detector for other cities.
 * Order matters only for display; matching is substring-based.
 */
export const SHANGHAI_BRAND_TOKENS = [
  "沪上",
  "本帮",
  "上海菜",
  "上海老",
  "上海风味",
  "海派",
  "老上海",
];

/** Tokens that imply Cantonese cuisine — used for Guangzhou ranking boost. */
const CANTONESE_TOKENS = [
  "粤菜",
  "广式",
  "广府",
  "顺德",
  "潮汕",
  "潮州",
  "茶餐厅",
  "早茶",
  "点心",
  "烧腊",
  "云吞",
  "肠粉",
  "粤式",
];

const SICHUAN_TOKENS = ["川菜", "四川", "麻辣", "火锅", "串串", "蜀", "巴蜀", "成都"];

const SHAANXI_TOKENS = [
  "陕菜",
  "陕西",
  "西安",
  "肉夹馍",
  "凉皮",
  "biangbiang",
  "biáng",
  "面馆",
  "羊肉泡馍",
];

const BEIJING_TOKENS = ["北京菜", "京菜", "老北京", "烤鸭", "炸酱面", "涮肉"];

const ZHEJIANG_TOKENS = ["杭帮", "杭州菜", "江浙菜", "西湖", "本帮"];

const CHONGQING_TOKENS = ["重庆", "山城", "麻辣", "火锅", "江湖菜"];

const NANJING_TOKENS = ["金陵", "南京", "盐水鸭", "鸭血", "本帮"];

/**
 * Per-city local cuisine keyword list, ordered most-specific → broadest. The
 * first 2-3 entries are the ones we use as Amap search keywords; the longer
 * tail is used for matching/ranking.
 *
 * Add a city by appending here — every consumer reads through these helpers.
 */
const CITY_LOCAL_CUISINES: Record<CityKey, string[]> = {
  shanghai: ["本帮菜", "上海菜", "小笼", "生煎"],
  beijing: ["北京菜", "老北京", "烤鸭", "炸酱面"],
  guangzhou: ["粤菜", "早茶", "茶餐厅", "广府菜", "烧腊", "顺德菜"],
  shenzhen: ["粤菜", "茶餐厅", "潮汕菜", "广府菜"],
  chengdu: ["川菜", "成都火锅", "串串香", "蜀菜"],
  hangzhou: ["杭帮菜", "江浙菜", "西湖醋鱼"],
  chongqing: ["重庆火锅", "川菜", "江湖菜"],
  xian: ["陕西菜", "陕菜", "肉夹馍", "凉皮", "面馆"],
  nanjing: ["金陵菜", "江浙菜", "盐水鸭"],
};

/** Token sets used to detect that a POI's name/type matches the local cuisine. */
const CITY_MATCH_TOKENS: Record<CityKey, string[]> = {
  shanghai: ["本帮", "沪", "上海菜", "海派", "小笼", "生煎"],
  beijing: BEIJING_TOKENS,
  guangzhou: CANTONESE_TOKENS,
  shenzhen: CANTONESE_TOKENS,
  chengdu: SICHUAN_TOKENS,
  hangzhou: ZHEJIANG_TOKENS,
  chongqing: CHONGQING_TOKENS,
  xian: SHAANXI_TOKENS,
  nanjing: NANJING_TOKENS,
};

/**
 * Per-city foreign-brand tokens — names containing any of these are treated
 * as out-of-city in this city and get ranking penalty. Empty array = no
 * penalty (e.g. Shanghai itself).
 */
const FOREIGN_BRAND_TOKENS: Record<CityKey, string[]> = {
  shanghai: [],
  beijing: SHANGHAI_BRAND_TOKENS,
  guangzhou: SHANGHAI_BRAND_TOKENS,
  shenzhen: SHANGHAI_BRAND_TOKENS,
  chengdu: SHANGHAI_BRAND_TOKENS,
  hangzhou: [], // 杭州 shares 江浙菜 with 上海 — don't penalize.
  chongqing: SHANGHAI_BRAND_TOKENS,
  xian: SHANGHAI_BRAND_TOKENS,
  nanjing: [],
};

/**
 * Resolve a city key from any of:
 *  - CityKey ("guangzhou")
 *  - Chinese name ("广州"/"广州市")
 *  - English name ("Guangzhou")
 * Returns null when nothing matches — callers should treat that as "unknown
 * city, use generic local hints" rather than defaulting to Shanghai.
 */
export function resolveCityKey(label: string | undefined | null): CityKey | null {
  if (!label) return null;
  const raw = String(label).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const stripped = raw.replace(/(市|区|省|特别行政区)$/u, "").trim();
  const lowerStripped = stripped.toLowerCase();

  const map: Array<[CityKey, string[]]> = [
    ["shanghai", ["shanghai", "上海", "沪"]],
    ["beijing", ["beijing", "北京", "京"]],
    ["guangzhou", ["guangzhou", "广州", "羊城", "穗"]],
    ["shenzhen", ["shenzhen", "深圳", "鹏城"]],
    ["chengdu", ["chengdu", "成都", "蓉城", "蓉"]],
    ["hangzhou", ["hangzhou", "杭州"]],
    ["chongqing", ["chongqing", "重庆", "渝", "山城"]],
    ["xian", ["xian", "xi'an", "西安", "长安"]],
    ["nanjing", ["nanjing", "南京", "金陵"]],
  ];
  for (const [key, aliases] of map) {
    for (const a of aliases) {
      const al = a.toLowerCase();
      if (al === lower || al === lowerStripped) return key;
      if (a === stripped) return key;
    }
  }
  return null;
}

/**
 * Local cuisine keyword list for a city. Returns the canonical list when the
 * city is known, otherwise a generic ["本地特色", "餐厅"] fallback so callers
 * never silently inject 本帮菜.
 */
export function localCuisinesFor(label: string | undefined | null): string[] {
  const key = resolveCityKey(label);
  if (!key) return ["本地特色", "餐厅"];
  return [...CITY_LOCAL_CUISINES[key]];
}

/**
 * Top-N cuisine keywords suitable for an Amap restaurant search. Capped to
 * keep network volume bounded.
 */
export function topLocalCuisinesFor(
  label: string | undefined | null,
  limit = 3,
): string[] {
  return localCuisinesFor(label).slice(0, Math.max(1, limit));
}

/**
 * True when the cuisine `c` is a Shanghai-style cuisine token. Used by the
 * generalization ladder to decide whether to allow 本帮菜 → 上海菜 → 江浙菜
 * widening (it's only safe in Shanghai/Hangzhou/Nanjing where 江浙 cuisine
 * is also locally authentic).
 */
export function isShanghaiCuisine(c: string): boolean {
  if (!c) return false;
  return SHANGHAI_BRAND_TOKENS.some((t) => c.includes(t));
}

/**
 * Generalize a cuisine token within the city's culinary family. Returns
 * broader synonyms ordered by specificity. The key behavioural rule:
 *
 *   - 本帮菜/上海菜 only widens to 江浙菜/中餐 when the city allows 江浙
 *     cuisine (上海/杭州/南京). In other cities the cascade short-circuits
 *     after the original cuisine and falls back to the local-cuisine list.
 *
 * This prevents the previous bug where a user typing "本帮菜" in Guangzhou
 * had the cascade silently pull in 江浙菜 results, polluting the plan.
 */
export function generalizeCuisine(
  cuisine: string,
  cityLabel?: string | null,
): string[] {
  const key = resolveCityKey(cityLabel);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (c: string) => {
    const t = c.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  if (isShanghaiCuisine(cuisine)) {
    if (cuisine !== "上海菜") push("上海菜");
    // When city is unknown OR in the Shanghai/江浙 family, allow widening to
    // 江浙菜. Only explicitly non-江浙 cities (Guangzhou, Beijing, etc.)
    // short-circuit to 中餐.
    const allowsJiangzhe =
      key === null ||
      key === "shanghai" ||
      key === "hangzhou" ||
      key === "nanjing";
    if (allowsJiangzhe) {
      push("江浙菜");
      push("中餐");
    } else {
      // Don't widen to 江浙菜 in non-Shanghai-family cities. Just allow 中餐
      // as the terminal fallback so the cascade still has somewhere to go.
      push("中餐");
    }
    return out;
  }

  // Generic ladder for non-Shanghai cuisines.
  switch (cuisine) {
    case "粤菜":
      push("广府菜");
      push("中餐");
      break;
    case "早茶":
      push("茶餐厅");
      push("点心");
      break;
    case "茶餐厅":
      push("粤菜");
      push("点心");
      break;
    case "川菜":
      push("成都火锅");
      push("中餐");
      break;
    case "陕西菜":
    case "陕菜":
      push("面馆");
      push("中餐");
      break;
    case "杭帮菜":
      push("江浙菜");
      push("中餐");
      break;
    case "北京菜":
      push("中餐");
      break;
    default:
      // No specific generalization — let the caller fall back to local cuisines.
      break;
  }
  return out;
}

/**
 * Penalty score for a POI whose name/brand is "from another city" given the
 * current city. Returns a non-negative number to subtract from the candidate
 * score. 0 = no penalty.
 *
 * The classic case: name "沪上阿姨" in Guangzhou — penalize so it ranks below
 * a real 茶餐厅. We deliberately use the *name* (not the type), since Amap
 * categorizes 沪上阿姨 as 饮品店 in every city.
 */
export function foreignBrandPenalty(
  name: string | undefined | null,
  cityLabel?: string | null,
): number {
  const n = (name || "").trim();
  if (!n) return 0;
  const key = resolveCityKey(cityLabel);
  if (!key) return 0;
  const tokens = FOREIGN_BRAND_TOKENS[key];
  if (!tokens.length) return 0;
  for (const tok of tokens) {
    if (n.includes(tok)) return 0.4; // strong penalty — push below local options
  }
  return 0;
}

/**
 * Score boost when the POI's name OR raw_type matches the city's local
 * cuisine tokens. Returns a non-negative number to add to the score.
 */
export function localCuisineBoost(
  name: string | undefined | null,
  rawType: string | undefined | null,
  cityLabel?: string | null,
): number {
  const key = resolveCityKey(cityLabel);
  if (!key) return 0;
  const tokens = CITY_MATCH_TOKENS[key];
  if (!tokens?.length) return 0;
  const hay = `${name || ""} ${rawType || ""}`.toLowerCase();
  for (const tok of tokens) {
    if (hay.includes(tok.toLowerCase())) return 0.25;
  }
  return 0;
}

/**
 * True when the POI looks like it's NOT from the current city's cuisine
 * family AND looks like a foreign-brand chain. Used by ranking gates to
 * filter rather than just penalize when alternatives exist.
 */
export function looksForeignBrand(
  name: string | undefined | null,
  cityLabel?: string | null,
): boolean {
  return foreignBrandPenalty(name, cityLabel) > 0;
}
