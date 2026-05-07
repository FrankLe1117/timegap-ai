/**
 * Synthetic-place detection and timeline sanitization.
 *
 * The demo city graph contains category-style names like "徐家汇本帮小馆" and
 * "武康路精品咖啡馆" that look like real shops but are not real POIs. If we
 * surface them as concrete stops with a "在高德打开" link the user clicks it
 * and lands on a guessed/wrong location. This module is the single source of
 * truth for:
 *
 * 1) Detecting that pattern (`isSyntheticConcretePlaceName`).
 * 2) Rewriting an offending TimelineItem so it reads as a directional
 *    suggestion ("徐汇区附近一家本帮菜小馆") with `place_kind: "directional"`,
 *    no coordinates, and no nav URL — so the UI cannot render a map link.
 * 3) `sanitizeTimelineItem` / `sanitizePlanResponse` — final guards used by
 *    the planner and the API route.
 *
 * Stops that come from real candidate pool replacements (`source !== "demo"`
 * with a non-"suggested" reliability) are passed through untouched.
 */
import type { Plan, PlanResponse, RouteHop, TimelineItem } from "@/types";

/**
 * Patterns that match category-style names of the form "<area/cuisine><tail>".
 * The tail tokens are the same set as candidate-pool's reliability gate so the
 * two stay in sync.
 */
const SYNTHETIC_TAIL_RE =
  /^.{0,12}(本帮|小馆|餐厅|餐馆|饭馆|食堂|酒楼|小酒馆|酒馆|咖啡店?|咖啡馆|休息点|快餐区|周边日料|日料|小吃|茶馆|书吧|简餐|商务简餐|本帮简餐|本帮菜|本帮菜餐厅|老字号餐厅|晚餐|午餐|早餐)$/u;

/** Long directional placeholders the planner emits for non-Shanghai cities, of
 *  the form "<area>附近一家<cuisine>小馆/餐馆/餐厅/咖啡馆/茶馆/小吃店". The
 *  area chunk can be any length and may include parens like
 *  "珠江新城(地铁站)" — short SYNTHETIC_TAIL_RE's `.{0,12}` cap silently
 *  misses those, which is how a synthetic name with a tag-style reason
 *  ("#local_food #dinner") and a fake "在高德打开" link reached the UI. */
const SYNTHETIC_DIRECTIONAL_RE =
  /^.+?附近一家.{0,12}(小馆|餐馆|餐厅|饭馆|食堂|酒楼|咖啡馆|咖啡店|茶馆|小吃店|小吃)$/u;

const SYNTHETIC_BARE_RE = /^(本帮|小馆|餐厅|餐馆|饭馆|食堂|酒楼|咖啡|景点|公园|书吧|茶馆|快餐|简餐|小吃)$/u;

/**
 * Returns true when `name` looks like a "fake concrete POI" — the classic
 * <area><cuisine><tail> shape. Real POIs occasionally collide with this
 * pattern, but they should always come from a candidate pool with a real
 * upstream id; we never apply this gate to non-demo stops.
 */
export function isSyntheticConcretePlaceName(name: string | undefined | null): boolean {
  const n = (name || "").trim();
  if (!n) return false;
  if (SYNTHETIC_BARE_RE.test(n)) return true;
  if (SYNTHETIC_TAIL_RE.test(n)) return true;
  if (SYNTHETIC_DIRECTIONAL_RE.test(n)) return true;
  return false;
}

/** Activity types where a synthetic concrete name is most damaging. */
const COMMERCIAL_ACTIVITIES: ReadonlySet<TimelineItem["activity_type"]> = new Set([
  "lunch",
  "dinner",
  "coffee",
]);

/**
 * Cuisine/category hint extracted from a synthetic name, used to phrase the
 * directional fallback. Falls back to a generic "本地" prefix when nothing
 * specific matches.
 */
function extractCuisineHint(name: string): string {
  const n = name || "";
  if (/本帮|上海菜/.test(n)) return "本帮菜";
  // 早茶 must be checked before the broader 粤菜 branch — when the planner
  // emitted "...附近一家早茶小馆", we want the resolver to search 早茶, not
  // generic 粤菜.
  if (/早茶/.test(n)) return "早茶";
  if (/茶餐厅/.test(n)) return "茶餐厅";
  if (/粤菜|广府|烧腊|顺德/.test(n)) return "粤菜";
  if (/川菜|火锅|串串|麻辣/.test(n)) return "川菜";
  if (/陕菜|肉夹馍|凉皮|羊肉泡馍/.test(n)) return "陕菜";
  if (/杭帮/.test(n)) return "杭帮菜";
  if (/京菜|烤鸭|老北京/.test(n)) return "北京菜";
  if (/法式|法餐/.test(n)) return "法餐";
  if (/日料/.test(n)) return "日料";
  if (/咖啡馆?|咖啡店/.test(n)) return "咖啡";
  if (/茶馆/.test(n)) return "茶";
  if (/小吃|快餐|简餐/.test(n)) return "本地小吃";
  if (/老字号/.test(n)) return "老字号餐厅";
  if (/休息点/.test(n)) return "咖啡/休息";
  return "本地餐";
}

function suggestionTail(activity: TimelineItem["activity_type"], hint: string): string {
  if (activity === "coffee") return "找一家咖啡馆休息";
  if (hint.includes("茶")) return "找一家茶馆";
  if (hint.includes("咖啡")) return "找一家咖啡馆";
  if (hint.includes("小吃")) return "尝一份本地小吃";
  return `找一家${hint}小馆`;
}

/** Build a non-clickable directional title/place_name from the original demo node. */
function buildDirectionalText(
  area: string | undefined,
  originalName: string,
  activity: TimelineItem["activity_type"],
): { placeName: string; titleLabel: string } {
  const hint = extractCuisineHint(originalName);
  const district = (area || "").trim();
  const where = district ? `${district}附近` : "附近";
  const tail = suggestionTail(activity, hint);
  // place_name doubles as the body shown when the user has no map link, so we
  // make it readable on its own.
  const placeName = `${where}${tail}（方向建议）`;
  const titleLabel =
    activity === "lunch" ? `午餐：${where}${tail}` :
    activity === "dinner" ? `晚餐：${where}${tail}` :
    activity === "coffee" ? `咖啡休息：${where}${tail}` :
    `${where}${tail}`;
  return { placeName, titleLabel };
}

/**
 * If `item` is a demo commercial stop with a synthetic concrete name, rewrite
 * it to a directional suggestion. Real-candidate stops, transport legs, and
 * station buffers pass through unchanged.
 *
 * `area` is the demo node's area field, used to phrase the suggestion
 * ("徐汇区附近一家本帮菜小馆"). It can be omitted; the fallback wording still
 * reads cleanly without it.
 */
/**
 * Tag-style reason like "#local_food #budget #quick_meal" — emitted by the
 * planner from `node.tags.slice(0, 3).map(t => "#" + t).join(" ")`. These are
 * internal metadata tokens; rendering them as the user-facing description for
 * a directional stop makes the UI look like leaked debug output, so we always
 * overwrite when sanitizing.
 */
function isTagStyleReason(reason: string | undefined | null): boolean {
  const r = (reason || "").trim();
  if (!r) return false;
  // Every whitespace-separated chunk must look like a #tag token (`#` followed
  // by alphanumeric / underscore / hyphen / CJK ideographs). Single-token
  // reasons like `#local_food` count too — they're still leaked metadata.
  const parts = r.split(/\s+/);
  if (parts.length === 0) return false;
  const tag = /^#[\w\-一-鿿]+$/u;
  return parts.every((p) => tag.test(p));
}

export function sanitizeTimelineItem(
  item: TimelineItem,
  area?: string,
): TimelineItem {
  if (item.activity_type === "transport" || item.activity_type === "station_buffer") {
    return item;
  }
  // Real candidate replacements ride through. They've already passed the
  // candidate-pool reliability gate (allow_in_itinerary === true).
  const fromRealCandidate =
    item.source && item.source !== "demo" && item.candidate_reliability !== "suggested";
  if (fromRealCandidate) return item;

  // Defense-in-depth: a stop that arrived already tagged `place_kind:
  // "directional"` came from the planner's own emission (e.g. the
  // non-Shanghai cuisine-keyed stops "珠江新城附近一家早茶小馆"). Its name
  // and area are *intentional* — preserve them. We only strip raw fields
  // that could let the UI render a verified-POI link, and we scrub
  // tag-style reasons so internal metadata doesn't leak.
  if (item.place_kind === "directional") {
    const cleanReason =
      !item.reason || isTagStyleReason(item.reason)
        ? "演示版未绑定具体店铺，待高德搜索匹配"
        : item.reason;
    return {
      ...item,
      // Strip every field that could decorate the stop as a verified POI.
      place_id: undefined,
      lng: undefined,
      lat: undefined,
      amap_url: undefined,
      candidate_score: undefined,
      candidate_reliability: undefined,
      reason: cleanReason,
    };
  }

  if (!COMMERCIAL_ACTIVITIES.has(item.activity_type)) return item;
  if (!isSyntheticConcretePlaceName(item.place_name)) return item;

  const { placeName, titleLabel } = buildDirectionalText(area, item.place_name, item.activity_type);
  // Tag-style reasons (e.g. "#local_food #budget #quick_meal") leak internal
  // metadata into the UI, so always replace with a user-facing string.
  const cleanReason =
    !item.reason || isTagStyleReason(item.reason)
      ? "演示版未绑定具体店铺，已转为方向建议"
      : item.reason;
  // Strip every field that could let the UI render a map link.
  return {
    ...item,
    title: titleLabel,
    place_name: placeName,
    place_id: undefined,
    place_kind: "directional",
    lng: undefined,
    lat: undefined,
    amap_url: undefined,
    // Keep candidate_score absent; this is a demo suggestion, not a candidate.
    candidate_score: undefined,
    candidate_reliability: undefined,
    source: "demo",
    reason: cleanReason,
  };
}

/** Apply sanitization across a plan's timeline. Also rewrites route_chain so
 *  legs/stops point at the new directional names. */
export function sanitizePlan(
  plan: Plan,
  areaForName?: (placeName: string) => string | undefined,
): Plan {
  const lookup = areaForName || (() => undefined);
  const timeline: TimelineItem[] = [];
  // First pass — sanitize stops; for transports we may need the next stop's
  // (possibly rewritten) name to keep titles consistent.
  const stopRewrites = new Map<string, string>(); // old place_name → new
  for (const it of plan.timeline) {
    const sanitized = sanitizeTimelineItem(it, lookup(it.place_name));
    if (sanitized !== it && sanitized.place_name !== it.place_name) {
      stopRewrites.set(it.place_name, sanitized.place_name);
    }
    timeline.push(sanitized);
  }
  // Second pass — patch transport legs that name a rewritten stop.
  const patched = timeline.map((it) => {
    if (it.activity_type !== "transport") return it;
    const replacement = stopRewrites.get(it.place_name);
    if (!replacement) return it;
    return {
      ...it,
      title: `前往${replacement}`,
      place_name: replacement,
      place_id: undefined,
      place_kind: "directional" as const,
      lng: undefined,
      lat: undefined,
      amap_url: undefined,
    };
  });

  // Patch the route chain similarly so it stays consistent with the timeline.
  const route_chain: RouteHop[] = plan.route_chain.map((hop) => {
    const fromR = stopRewrites.get(hop.from);
    const toR = stopRewrites.get(hop.to);
    if (!fromR && !toR) return hop;
    return { ...hop, from: fromR || hop.from, to: toR || hop.to };
  });

  return { ...plan, timeline: patched, route_chain };
}

/**
 * Final guard applied just before the API hands the response to the client.
 * Idempotent — passing an already-sanitized response is a no-op.
 */
export function sanitizePlanResponse(
  response: PlanResponse,
  areaForName?: (placeName: string) => string | undefined,
): PlanResponse {
  const plans = response.plans.map((p) => sanitizePlan(p, areaForName));
  return { ...response, plans };
}
