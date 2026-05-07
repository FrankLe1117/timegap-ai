/**
 * City + city-aware POI detection for Chinese free-form trip input.
 *
 * Why this exists: the original parser hardcoded Shanghai-only POIs (陆家嘴 /
 * 虹桥站) and Shanghai-only defaults. A user in Guangzhou ("珠江新城 → 白云机
 * 场") would have both endpoints fall back to Shanghai anchors, silently
 * changing the user's intent.
 *
 * This module owns:
 *   - detectCity(text)  — identify the user's city by scanning for known
 *     city names + signature POIs.
 *   - locateInCity(city, text) — pick the best start/destination from the
 *     known anchor list for that city.
 *   - getCityDefaults(city) — city-aware fallback anchors used only when
 *     nothing was extracted.
 *
 * The dictionary is intentionally small but covers the major business
 * destinations: 上海 / 北京 / 广州 / 深圳 / 成都 / 杭州 / 重庆 / 西安 / 南京.
 */

export type CityKey =
  | "shanghai"
  | "beijing"
  | "guangzhou"
  | "shenzhen"
  | "chengdu"
  | "hangzhou"
  | "chongqing"
  | "xian"
  | "nanjing";

export interface CityAnchor {
  /** Canonical Chinese name surfaced to the user / planner. */
  name: string;
  /** Aliases the parser will match (substring). Order matters: more specific
   *  aliases must come before shorter prefixes (e.g. "广州白云国际机场" before
   *  "白云机场" before "白云"). */
  aliases: string[];
  /** Whether this anchor is a transit terminal (station/airport). */
  terminal: boolean;
}

export interface CityProfile {
  key: CityKey;
  /** Display name in Chinese. */
  zh: string;
  /** English label used by `Constraints.city` for legacy consumers. */
  en: string;
  /** Substrings that strongly imply this city (city name, district hints). */
  cityAliases: string[];
  /** Default fallback start anchor. */
  defaultStart: string;
  /** Default fallback final destination (typically the main rail station). */
  defaultDest: string;
  /** Known POIs the parser can extract from free-form text. */
  anchors: CityAnchor[];
}

const SHANGHAI: CityProfile = {
  key: "shanghai",
  zh: "上海",
  en: "Shanghai",
  cityAliases: ["上海", "沪", "shanghai"],
  defaultStart: "陆家嘴",
  defaultDest: "上海虹桥站",
  anchors: [
    { name: "陆家嘴", aliases: ["陆家嘴"], terminal: false },
    { name: "人民广场", aliases: ["人民广场"], terminal: false },
    { name: "静安寺", aliases: ["静安寺"], terminal: false },
    { name: "新天地", aliases: ["新天地"], terminal: false },
    { name: "外滩", aliases: ["外滩"], terminal: false },
    { name: "武康路", aliases: ["武康路"], terminal: false },
    { name: "田子坊", aliases: ["田子坊"], terminal: false },
    { name: "豫园", aliases: ["豫园"], terminal: false },
    { name: "南京路步行街", aliases: ["南京路"], terminal: false },
    { name: "虹桥天地", aliases: ["虹桥天地"], terminal: false },
    { name: "上海虹桥站", aliases: ["虹桥火车站", "虹桥站", "虹桥高铁", "虹桥"], terminal: true },
    { name: "上海浦东国际机场", aliases: ["浦东国际机场", "浦东机场"], terminal: true },
    { name: "上海虹桥国际机场", aliases: ["虹桥国际机场", "虹桥机场"], terminal: true },
    { name: "上海站", aliases: ["上海火车站", "上海站"], terminal: true },
    { name: "上海南站", aliases: ["上海南站"], terminal: true },
  ],
};

const BEIJING: CityProfile = {
  key: "beijing",
  zh: "北京",
  en: "Beijing",
  cityAliases: ["北京", "京城", "beijing"],
  defaultStart: "国贸",
  defaultDest: "北京南站",
  anchors: [
    { name: "国贸", aliases: ["国贸"], terminal: false },
    { name: "三里屯", aliases: ["三里屯"], terminal: false },
    { name: "中关村", aliases: ["中关村"], terminal: false },
    { name: "王府井", aliases: ["王府井"], terminal: false },
    { name: "南锣鼓巷", aliases: ["南锣鼓巷"], terminal: false },
    { name: "什刹海", aliases: ["什刹海"], terminal: false },
    { name: "鼓楼", aliases: ["鼓楼"], terminal: false },
    { name: "望京", aliases: ["望京"], terminal: false },
    { name: "北京南站", aliases: ["北京南站"], terminal: true },
    { name: "北京西站", aliases: ["北京西站"], terminal: true },
    { name: "北京站", aliases: ["北京火车站", "北京站"], terminal: true },
    { name: "北京朝阳站", aliases: ["北京朝阳站"], terminal: true },
    { name: "北京丰台站", aliases: ["北京丰台站"], terminal: true },
    { name: "首都国际机场", aliases: ["首都国际机场", "首都机场"], terminal: true },
    { name: "北京大兴国际机场", aliases: ["大兴国际机场", "大兴机场"], terminal: true },
  ],
};

const GUANGZHOU: CityProfile = {
  key: "guangzhou",
  zh: "广州",
  en: "Guangzhou",
  cityAliases: ["广州", "羊城", "穗", "guangzhou"],
  defaultStart: "珠江新城",
  defaultDest: "广州白云国际机场",
  anchors: [
    { name: "珠江新城", aliases: ["珠江新城"], terminal: false },
    { name: "天河", aliases: ["天河城", "天河"], terminal: false },
    { name: "北京路", aliases: ["北京路"], terminal: false },
    { name: "上下九", aliases: ["上下九"], terminal: false },
    { name: "沙面", aliases: ["沙面"], terminal: false },
    { name: "永庆坊", aliases: ["永庆坊"], terminal: false },
    { name: "琶醍", aliases: ["琶醍"], terminal: false },
    { name: "广州白云国际机场", aliases: ["广州白云国际机场", "白云国际机场", "白云机场"], terminal: true },
    { name: "广州南站", aliases: ["广州南站"], terminal: true },
    { name: "广州东站", aliases: ["广州东站"], terminal: true },
    { name: "广州站", aliases: ["广州火车站", "广州站"], terminal: true },
    { name: "广州北站", aliases: ["广州北站"], terminal: true },
  ],
};

const SHENZHEN: CityProfile = {
  key: "shenzhen",
  zh: "深圳",
  en: "Shenzhen",
  cityAliases: ["深圳", "鹏城", "shenzhen"],
  defaultStart: "福田",
  defaultDest: "深圳北站",
  anchors: [
    { name: "福田", aliases: ["福田"], terminal: false },
    { name: "南山", aliases: ["南山"], terminal: false },
    { name: "华侨城", aliases: ["华侨城"], terminal: false },
    { name: "蛇口", aliases: ["蛇口"], terminal: false },
    { name: "海岸城", aliases: ["海岸城"], terminal: false },
    { name: "深圳北站", aliases: ["深圳北站"], terminal: true },
    { name: "深圳站", aliases: ["深圳火车站", "深圳站"], terminal: true },
    { name: "福田站", aliases: ["福田站"], terminal: true },
    { name: "深圳宝安国际机场", aliases: ["宝安国际机场", "宝安机场", "深圳机场"], terminal: true },
  ],
};

const CHENGDU: CityProfile = {
  key: "chengdu",
  zh: "成都",
  en: "Chengdu",
  cityAliases: ["成都", "蓉城", "蓉", "chengdu"],
  defaultStart: "春熙路",
  defaultDest: "成都东站",
  anchors: [
    { name: "春熙路", aliases: ["春熙路"], terminal: false },
    { name: "天府广场", aliases: ["天府广场"], terminal: false },
    { name: "宽窄巷子", aliases: ["宽窄巷子"], terminal: false },
    { name: "锦里", aliases: ["锦里"], terminal: false },
    { name: "太古里", aliases: ["太古里"], terminal: false },
    { name: "成都东站", aliases: ["成都东站"], terminal: true },
    { name: "成都南站", aliases: ["成都南站"], terminal: true },
    { name: "成都西站", aliases: ["成都西站"], terminal: true },
    { name: "成都站", aliases: ["成都火车站", "成都站"], terminal: true },
    { name: "成都双流国际机场", aliases: ["双流国际机场", "双流机场"], terminal: true },
    { name: "成都天府国际机场", aliases: ["天府国际机场", "天府机场"], terminal: true },
  ],
};

const HANGZHOU: CityProfile = {
  key: "hangzhou",
  zh: "杭州",
  en: "Hangzhou",
  cityAliases: ["杭州", "西子", "hangzhou"],
  defaultStart: "西湖",
  defaultDest: "杭州东站",
  anchors: [
    { name: "西湖", aliases: ["西湖"], terminal: false },
    { name: "湖滨银泰", aliases: ["湖滨银泰", "湖滨"], terminal: false },
    { name: "武林广场", aliases: ["武林广场"], terminal: false },
    { name: "钱江新城", aliases: ["钱江新城"], terminal: false },
    { name: "灵隐寺", aliases: ["灵隐寺"], terminal: false },
    { name: "杭州东站", aliases: ["杭州东站"], terminal: true },
    { name: "杭州站", aliases: ["杭州城站", "杭州站"], terminal: true },
    { name: "杭州西站", aliases: ["杭州西站"], terminal: true },
    { name: "杭州萧山国际机场", aliases: ["萧山国际机场", "萧山机场"], terminal: true },
  ],
};

const CHONGQING: CityProfile = {
  key: "chongqing",
  zh: "重庆",
  en: "Chongqing",
  cityAliases: ["重庆", "山城", "渝", "chongqing"],
  defaultStart: "解放碑",
  defaultDest: "重庆北站",
  anchors: [
    { name: "解放碑", aliases: ["解放碑"], terminal: false },
    { name: "洪崖洞", aliases: ["洪崖洞"], terminal: false },
    { name: "观音桥", aliases: ["观音桥"], terminal: false },
    { name: "南滨路", aliases: ["南滨路"], terminal: false },
    { name: "重庆北站", aliases: ["重庆北站"], terminal: true },
    { name: "重庆西站", aliases: ["重庆西站"], terminal: true },
    { name: "重庆站", aliases: ["重庆火车站", "重庆站"], terminal: true },
    { name: "重庆江北国际机场", aliases: ["江北国际机场", "江北机场"], terminal: true },
  ],
};

const XIAN: CityProfile = {
  key: "xian",
  zh: "西安",
  en: "Xi'an",
  cityAliases: ["西安", "长安", "xi'an", "xian"],
  defaultStart: "钟楼",
  defaultDest: "西安北站",
  anchors: [
    { name: "钟楼", aliases: ["钟楼"], terminal: false },
    { name: "回民街", aliases: ["回民街"], terminal: false },
    { name: "大唐不夜城", aliases: ["大唐不夜城"], terminal: false },
    { name: "大雁塔", aliases: ["大雁塔"], terminal: false },
    { name: "西安北站", aliases: ["西安北站"], terminal: true },
    { name: "西安站", aliases: ["西安火车站", "西安站"], terminal: true },
    { name: "西安咸阳国际机场", aliases: ["咸阳国际机场", "咸阳机场"], terminal: true },
  ],
};

const NANJING: CityProfile = {
  key: "nanjing",
  zh: "南京",
  en: "Nanjing",
  cityAliases: ["南京", "金陵", "宁", "nanjing"],
  defaultStart: "新街口",
  defaultDest: "南京南站",
  anchors: [
    { name: "新街口", aliases: ["新街口"], terminal: false },
    { name: "夫子庙", aliases: ["夫子庙"], terminal: false },
    { name: "总统府", aliases: ["总统府"], terminal: false },
    { name: "玄武湖", aliases: ["玄武湖"], terminal: false },
    { name: "南京南站", aliases: ["南京南站"], terminal: true },
    { name: "南京站", aliases: ["南京火车站", "南京站"], terminal: true },
    { name: "南京禄口国际机场", aliases: ["禄口国际机场", "禄口机场"], terminal: true },
  ],
};

const PROFILES: Record<CityKey, CityProfile> = {
  shanghai: SHANGHAI,
  beijing: BEIJING,
  guangzhou: GUANGZHOU,
  shenzhen: SHENZHEN,
  chengdu: CHENGDU,
  hangzhou: HANGZHOU,
  chongqing: CHONGQING,
  xian: XIAN,
  nanjing: NANJING,
};

const ALL_PROFILES: CityProfile[] = Object.values(PROFILES);

/**
 * Detect the city most strongly implied by `text`.
 *
 * Strategy:
 *   1. Score each profile by (a) presence of its city name aliases (weight 3)
 *      and (b) presence of its terminal POI aliases (weight 2) and (c) any
 *      anchor alias (weight 1).
 *   2. Pick the highest-scoring profile when score > 0.
 *   3. Default to Shanghai when no signal — keeps old single-city users intact.
 */
export function detectCity(text: string): CityProfile {
  if (!text) return SHANGHAI;
  const t = text.toLowerCase();
  let best: { profile: CityProfile; score: number } = { profile: SHANGHAI, score: 0 };
  for (const p of ALL_PROFILES) {
    let score = 0;
    for (const a of p.cityAliases) if (t.includes(a.toLowerCase())) score += 3;
    for (const anchor of p.anchors) {
      for (const al of anchor.aliases) {
        if (t.includes(al.toLowerCase())) {
          score += anchor.terminal ? 2 : 1;
        }
      }
    }
    if (score > best.score) best = { profile: p, score };
  }
  return best.score > 0 ? best.profile : SHANGHAI;
}

/**
 * Find the first matching anchor in `profile` whose alias appears in `text`,
 * starting after `fromIndex`. Returns null when no match.
 *
 * Aliases are matched longest-first within each anchor so "广州白云国际机场"
 * wins over "白云机场" wins over "白云". Across anchors, the leftmost match
 * wins.
 */
function findAnchorMatch(
  text: string,
  profile: CityProfile,
  fromIndex: number,
  exclude: Set<string>,
): { anchor: CityAnchor; index: number; aliasLen: number } | null {
  let best: { anchor: CityAnchor; index: number; aliasLen: number } | null = null;
  const slice = text.slice(fromIndex);
  for (const a of profile.anchors) {
    if (exclude.has(a.name)) continue;
    const sortedAliases = [...a.aliases].sort((x, y) => y.length - x.length);
    for (const al of sortedAliases) {
      const i = slice.indexOf(al);
      if (i < 0) continue;
      const absIndex = fromIndex + i;
      if (best == null || absIndex < best.index || (absIndex === best.index && al.length > best.aliasLen)) {
        best = { anchor: a, index: absIndex, aliasLen: al.length };
      }
      break; // for this anchor we found the leftmost alias — done
    }
  }
  return best;
}

/**
 * Extract a (start, end) anchor pair for `text` within `profile`.
 *
 * Heuristic: scan the text in order; the first matched anchor becomes the
 * candidate start, the last *different* matched anchor becomes the end. We
 * then prefer to swap so the terminal anchor (station/airport) ends up as the
 * destination — that matches how users phrase trips ("从 X 出发，去 Y 站").
 */
export function locateInCity(
  profile: CityProfile,
  text: string,
): { start: string | null; end: string | null } {
  if (!text) return { start: null, end: null };
  const matches: { name: string; index: number; terminal: boolean }[] = [];
  const exclude = new Set<string>();
  let cursor = 0;
  // Bounded loop: each iteration consumes at least one character of text.
  while (cursor < text.length) {
    const m = findAnchorMatch(text, profile, cursor, exclude);
    if (!m) break;
    matches.push({ name: m.anchor.name, index: m.index, terminal: m.anchor.terminal });
    exclude.add(m.anchor.name);
    cursor = m.index + Math.max(m.aliasLen, 1);
  }
  if (matches.length === 0) return { start: null, end: null };
  matches.sort((a, b) => a.index - b.index);

  let startName = matches[0].name;
  let endName = matches[matches.length - 1].name;
  if (startName === endName) {
    // Only one distinct anchor — assign by terminal flag.
    if (matches[0].terminal) return { start: null, end: startName };
    return { start: startName, end: null };
  }
  // If the first anchor is a terminal and the last is not, swap so the
  // terminal becomes the destination — matches typical user phrasing.
  const startIsTerminal = matches[0].terminal;
  const endIsTerminal = matches[matches.length - 1].terminal;
  if (startIsTerminal && !endIsTerminal) {
    [startName, endName] = [endName, startName];
  }
  return { start: startName, end: endName };
}

export function getCityDefaults(profile: CityProfile): { start: string; dest: string } {
  return { start: profile.defaultStart, dest: profile.defaultDest };
}

/** Look up a profile by key. Defaults to Shanghai. */
export function profileByKey(key: CityKey | string | undefined | null): CityProfile {
  if (!key) return SHANGHAI;
  const k = String(key).toLowerCase();
  for (const p of ALL_PROFILES) {
    if (p.key === k) return p;
    if (p.en.toLowerCase() === k) return p;
    if (p.zh === key) return p;
  }
  return SHANGHAI;
}

/**
 * Best-effort lookup for a city profile from a name as Amap returns it
 * ("广州市" / "上海市" / "Guangzhou City" etc). Returns null when no known
 * profile matches — caller should treat that as "Amap-driven city, no
 * profile-specific anchors" rather than falling back to Shanghai.
 */
export function findProfileByCityName(cityName: string | undefined | null): CityProfile | null {
  if (!cityName) return null;
  const raw = String(cityName).trim();
  if (!raw) return null;
  // Strip trailing 市/区/省 (Amap often returns "广州市", "西安市" etc.)
  const stripped = raw.replace(/(市|区|省|特别行政区)$/u, "").trim();
  const lower = raw.toLowerCase();
  const lowerStripped = stripped.toLowerCase();
  for (const p of ALL_PROFILES) {
    if (p.zh === raw || p.zh === stripped) return p;
    if (p.en.toLowerCase() === lower || p.en.toLowerCase() === lowerStripped) return p;
    if (p.key === lowerStripped) return p;
    for (const a of p.cityAliases) {
      if (a.toLowerCase() === lower || a.toLowerCase() === lowerStripped) return p;
    }
  }
  return null;
}

/**
 * Normalize an arbitrary city label (English en, profile key, Chinese zh, or
 * Amap "广州市") to the Chinese name suitable for passing back to Amap as the
 * `city` parameter. Returns the input unchanged when no profile matches and
 * the input already looks Chinese; returns "上海" as last-resort fallback for
 * empty input.
 */
export function cityNameForAmap(label: string | undefined | null): string {
  if (!label || !String(label).trim()) return "上海";
  const raw = String(label).trim();
  const profile = findProfileByCityName(raw);
  if (profile) return profile.zh;
  if (/[一-鿿]/.test(raw)) return raw;
  return "上海";
}

export const CITY_PROFILES = PROFILES;