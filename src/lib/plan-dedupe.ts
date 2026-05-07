/**
 * Plan-level POI de-duplication.
 *
 * Multiple enrichment passes (Amap enrich, candidate replacement, directional
 * resolver) can each independently land on the same concrete POI for two
 * different slots in the same plan — e.g. lunch and dinner both resolved to
 * "玖·JIU餐厅(虹桥天地店)". The user then sees a 1-minute "前往玖·JIU餐厅"
 * transport leg from the same restaurant to itself.
 *
 * This module is the single dedupe primitive used by all of those passes,
 * plus a final-guard repair that runs on the response just before it leaves
 * the server.
 *
 * Strategy:
 *   - `stopKey(item)` returns a normalized key for a concrete POI stop:
 *     `place_id` when present, else `<normalized name>@<coord-bucket>` when
 *     coords exist, else `<normalized name>` alone. Directional / transport
 *     / station_buffer items have no key (return null).
 *   - Resolvers accept a "used" set, skip candidates whose key is already in
 *     it, and add the picked key after replacement.
 *   - `repairPlanDuplicates` is the final pass: it walks the timeline left
 *     to right; the first concrete stop with a given key wins, every later
 *     duplicate is converted to a directional fallback and any transport
 *     leg pointing at it is rewritten so it no longer reads "前往<同一家店>".
 */
import {
  AmapCoord,
  AmapPoi,
  buildAmapMarkerUrl,
  buildAmapNavigationUrl,
  buildAmapSearchUrl,
  buildRouteOptions,
} from "./amap-client";
import type { Plan, PlanResponse, RouteHop, TimelineItem } from "@/types";

/** Round to ~110 m — fine enough that two stops at the same shop collide,
 *  coarse enough that legitimately different POIs (different floors,
 *  different doors) don't accidentally collide. */
function bucketCoord(lng: number, lat: number): string {
  return `${lng.toFixed(3)},${lat.toFixed(3)}`;
}

function normalizeName(name: string): string {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    // Strip common bracketed branch suffixes so "玖·JIU(虹桥店)" and
    // "玖·JIU(虹桥天地店)" still collide on the core name when their coords
    // also bucket to the same point. We only do this when we already have a
    // coord bucket — see stopKey.
    .replace(/[（(][^（()）]*[)）]\s*$/u, "");
}

/**
 * Build a dedupe key for a TimelineItem. Returns null when the item is not
 * a concrete-POI stop we should dedupe (transport, buffer, directional).
 *
 * Preference order:
 *   1. place_id (real Amap id) — most reliable.
 *   2. normalized name + coord bucket — same shop within ~110 m.
 *   3. normalized name alone — last-resort, used when no coords are known
 *      (rare; means the stop is barely concrete).
 */
export function stopKey(item: TimelineItem): string | null {
  if (item.activity_type === "transport" || item.activity_type === "station_buffer") {
    return null;
  }
  if (item.place_kind === "directional") return null;
  // Directional fallback that lost its place_kind tag still has no coord
  // and the place_name reads "...（方向建议）". Treat as non-keyable.
  if ((item.place_name || "").includes("方向建议")) return null;

  const id = (item.place_id || "").trim();
  if (id) return `id:${id}`;

  const name = normalizeName(item.place_name || "");
  if (item.lng != null && item.lat != null) {
    return `nc:${name}@${bucketCoord(item.lng, item.lat)}`;
  }
  if (name) return `n:${name}`;
  return null;
}

/**
 * Collect dedupe keys for every concrete stop strictly *before* `untilIndex`
 * in `timeline`. Useful when a resolver is processing one slot at a time and
 * needs to know what earlier slots already used.
 *
 * Pass `untilIndex = timeline.length` to scan the whole plan (e.g. when
 * computing initial state before any rewrite).
 */
export function collectUsedKeys(timeline: TimelineItem[], untilIndex: number): Set<string> {
  const used = new Set<string>();
  for (let i = 0; i < Math.min(untilIndex, timeline.length); i++) {
    const k = stopKey(timeline[i]);
    if (k) used.add(k);
  }
  return used;
}

/**
 * Hints used to build an Amap *search* URL when we fall back to manual
 * confirmation. Always optional — when none/empty, the caller gets the
 * legacy directional placeholder with no search affordance.
 */
export interface MealSearchHints {
  /** City name passed into the Amap search URL (`city=...`). */
  city?: string;
  /** Area or landmark hint, e.g. "人民广场", "黄浦区". Used to build the
   *  search keyword: "<area> <cuisine|category>". */
  area?: string;
  /** Cuisine token like "本帮菜". When absent we fall back to a generic
   *  "餐厅"/"咖啡馆" depending on activity. */
  cuisine?: string;
}

function buildMealSearchKeyword(
  activity: TimelineItem["activity_type"],
  hints: MealSearchHints,
): { keyword: string; baseCategory: string } {
  const isCoffee = activity === "coffee";
  const baseCategory = isCoffee ? "咖啡馆" : "餐厅";
  const cuisine = (hints.cuisine || "").trim();
  const area = (hints.area || "").trim();
  const cat = cuisine || baseCategory;
  const keyword = area ? `${area} ${cat}` : cat;
  return { keyword, baseCategory };
}

/**
 * Convert a concrete-POI stop into a directional fallback in place. Strips
 * every field that could let the UI render a map link, marks the place_name
 * with the standard "方向建议，未绑定具体地点" tag, and preserves time / type.
 *
 * For meal/coffee stops, when Amap is reachable but no replacement could be
 * found, the caller can pass `mealManualConfirm: true` to switch to a clearer
 * "需要手动确认餐馆" placeholder rather than the generic "方向建议" one — this
 * makes it obvious to the user that they should pick somewhere themselves.
 *
 * When `searchHints` is also supplied, the placeholder is upgraded one more
 * step: it carries an actionable `search_url` (Amap keyword search, NOT a
 * verified POI marker) plus `place_kind: "search"`. The UI renders this as
 * "在高德搜索餐馆" so the user has a real way to confirm a place themselves.
 */
export function convertStopToDirectional(
  item: TimelineItem,
  options: { mealManualConfirm?: boolean; searchHints?: MealSearchHints } = {},
): TimelineItem {
  if (item.activity_type === "transport" || item.activity_type === "station_buffer") {
    return item;
  }
  const label =
    item.activity_type === "lunch" ? "午餐" :
    item.activity_type === "dinner" ? "晚餐" :
    item.activity_type === "coffee" ? "咖啡休息" :
    "推荐";
  const isMeal =
    item.activity_type === "lunch" ||
    item.activity_type === "dinner" ||
    item.activity_type === "coffee";
  const useManual = !!options.mealManualConfirm && isMeal;
  const hints = options.searchHints;
  const useSearch =
    useManual &&
    !!hints &&
    !!(hints.area || hints.cuisine || hints.city);
  let placeName: string;
  let reason: string;
  let place_kind: TimelineItem["place_kind"] = "directional";
  let search_url: string | undefined;
  let search_query: string | undefined;
  if (useSearch && hints) {
    const isCoffee = item.activity_type === "coffee";
    const noun = isCoffee ? "咖啡馆" : "餐馆";
    placeName = `需要手动确认${noun}`;
    const { keyword, baseCategory } = buildMealSearchKeyword(item.activity_type, hints);
    const isCuisinePrecise = !!hints.cuisine && hints.cuisine !== baseCategory;
    reason = isCuisinePrecise
      ? `高德未找到精确${hints.cuisine}，可在高德搜索“${keyword}”查看候选`
      : `未在高德找到精确候选，可搜索“${keyword}”手动选择一家`;
    place_kind = "search";
    search_url = buildAmapSearchUrl(keyword, hints.city || "上海");
    search_query = keyword;
  } else if (useManual) {
    placeName =
      item.activity_type === "coffee"
        ? "需要手动确认咖啡馆"
        : "需要手动确认餐馆";
    reason = "未在高德找到符合条件的备选店铺，请手动选择一家";
  } else {
    placeName = "方向建议，未绑定具体地点";
    reason = "已与同行程其他停留点重复，转为方向建议";
  }
  return {
    ...item,
    title: `${label}：${placeName}`,
    place_name: placeName,
    place_id: undefined,
    place_kind,
    lng: undefined,
    lat: undefined,
    amap_url: undefined,
    candidate_score: undefined,
    candidate_reliability: undefined,
    source: "demo",
    reason,
    search_url,
    search_query,
  };
}

/**
 * Repair duplicate concrete stops within a single plan.
 *
 * The first appearance of each dedupe key wins; every later duplicate is
 * converted to a directional fallback. Any transport leg whose place_name
 * references the duplicate stop is rewritten so it no longer reads
 * "前往<same place>", and the corresponding route_chain hops are updated
 * to point at the directional placeholder.
 */
export function repairPlanDuplicates(plan: Plan): { plan: Plan; convertedCount: number } {
  const seenKeys = new Set<string>();
  // Map from old place_name → new place_name, used to rewrite the transport
  // leg whose target was the duplicate stop, plus the route_chain hops.
  const renames = new Map<string, string>();
  // The set of stop indices we've converted, so we can also clean the
  // immediately-preceding transport leg (which targets this same stop name).
  const convertedIndices = new Set<number>();
  const newTimeline: TimelineItem[] = plan.timeline.map((it, i) => {
    const k = stopKey(it);
    if (!k) return it;
    if (!seenKeys.has(k)) {
      seenKeys.add(k);
      return it;
    }
    // Duplicate. Convert.
    const oldName = it.place_name;
    const converted = convertStopToDirectional(it);
    convertedIndices.add(i);
    if (converted.place_name !== oldName) renames.set(oldName, converted.place_name);
    return converted;
  });

  if (convertedIndices.size === 0) {
    return { plan, convertedCount: 0 };
  }

  // Rewrite the transport leg that fed each converted stop. The transport
  // leg always sits immediately before its destination stop in the timeline
  // — so look back from each converted index. We rewrite whichever transport
  // leg currently names the converted stop.
  const patched = newTimeline.map((it, i) => {
    if (it.activity_type !== "transport") return it;
    // Does this leg point at a converted stop? Either the leg's own
    // place_name still matches the duplicate's old name (renames hit), or
    // the leg sits immediately before a converted index and shares its name.
    const renamed = renames.get(it.place_name);
    const nextIsConverted = convertedIndices.has(i + 1);
    if (!renamed && !nextIsConverted) return it;
    const targetName = renamed || (nextIsConverted ? newTimeline[i + 1].place_name : it.place_name);
    return {
      ...it,
      title: `前往${targetName}`,
      place_name: targetName,
      place_id: undefined,
      place_kind: "directional" as const,
      lng: undefined,
      lat: undefined,
      amap_url: undefined,
      route_options: undefined,
    };
  });

  // Patch route_chain hops similarly.
  const route_chain: RouteHop[] = plan.route_chain.map((hop) => {
    const fromR = renames.get(hop.from);
    const toR = renames.get(hop.to);
    if (!fromR && !toR) return hop;
    return { ...hop, from: fromR || hop.from, to: toR || hop.to };
  });

  return {
    plan: { ...plan, timeline: patched, route_chain },
    convertedCount: convertedIndices.size,
  };
}

/** Apply `repairPlanDuplicates` to every plan in a response. */
export function repairResponseDuplicates(response: PlanResponse): {
  response: PlanResponse;
  convertedTotal: number;
} {
  let convertedTotal = 0;
  const plans = response.plans.map((p) => {
    const r = repairPlanDuplicates(p);
    convertedTotal += r.convertedCount;
    return r.plan;
  });
  if (convertedTotal === 0) return { response, convertedTotal: 0 };
  return { response: { ...response, plans }, convertedTotal };
}

/**
 * Resolver passed to `repairPlanDuplicatesWithAmap`. Should return a
 * non-duplicate POI for the duplicate meal stop, or null when nothing usable
 * was found. Implementations are expected to honor `usedKeys` and the
 * activity-bucket reliability gate (see `directional-resolver`).
 */
export type MealReplacementResolver = (args: {
  duplicate: TimelineItem;
  anchor: AmapCoord | null;
  usedKeys: Set<string>;
}) => Promise<AmapPoi | null>;

function activityLabel(activity: TimelineItem["activity_type"]): string {
  if (activity === "lunch") return "午餐";
  if (activity === "dinner") return "晚餐";
  if (activity === "coffee") return "咖啡休息";
  return "推荐";
}

/** Build a fresh concrete-POI stop from the original duplicate + a replacement. */
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

/**
 * Async, Amap-aware variant of `repairPlanDuplicates`. Walks the timeline left
 * to right; the first concrete stop with a given key wins. For every later
 * duplicate:
 *
 *   1. If the duplicate is a meal/coffee stop AND a `resolver` is supplied,
 *      try to find a *different* reliable nearby POI via that resolver.
 *      When found, rewrite the duplicate stop to the new POI and patch the
 *      transport leg that feeds it (title + nav URL + route options) so the
 *      timeline stays coherent.
 *   2. Otherwise (or when the resolver returns null), fall back to a
 *      manual-confirm placeholder. When `searchHintsFor` is provided, the
 *      placeholder carries a real Amap search URL ("在高德搜索餐馆") so the
 *      user has a way to confirm a place themselves; otherwise it falls
 *      back to the legacy text-only directional placeholder.
 *
 * Returns the patched plan plus counts split by repair path.
 */
export async function repairPlanDuplicatesWithAmap(
  plan: Plan,
  resolver?: MealReplacementResolver | null,
  startCoord: AmapCoord | null = null,
  searchHintsFor?: ((duplicate: TimelineItem) => MealSearchHints | null | undefined) | null,
): Promise<{
  plan: Plan;
  replacedCount: number;
  convertedCount: number;
}> {
  const seenKeys = new Set<string>();
  const renames = new Map<string, string>();
  const convertedIndices = new Set<number>();
  // For replacements (concrete → concrete), we keep enough info to patch
  // the preceding transport leg.
  type Replacement = { fromName: string; toName: string; coord: AmapCoord };
  const replacementByStopIndex = new Map<number, Replacement>();

  // Anchor walks alongside the plan so the resolver searches near the right
  // area. Mirrors the loop in directional-resolver.resolvePlan.
  let anchor: AmapCoord | null = startCoord;

  // First pass: identify duplicates, optionally resolve replacements.
  const newTimelineRaw: TimelineItem[] = [];
  for (let i = 0; i < plan.timeline.length; i++) {
    const it = plan.timeline[i];
    const k = stopKey(it);
    if (!k) {
      newTimelineRaw.push(it);
      continue;
    }
    if (!seenKeys.has(k)) {
      seenKeys.add(k);
      newTimelineRaw.push(it);
      if (it.lng != null && it.lat != null) {
        anchor = { lng: it.lng, lat: it.lat };
      }
      continue;
    }

    // Duplicate. If meal/coffee + resolver available, attempt replacement.
    const isMeal =
      it.activity_type === "lunch" ||
      it.activity_type === "dinner" ||
      it.activity_type === "coffee";
    let replaced: AmapPoi | null = null;
    if (isMeal && resolver) {
      try {
        replaced = await resolver({
          duplicate: it,
          anchor,
          usedKeys: new Set(seenKeys),
        });
      } catch (err) {
        console.warn("[plan-dedupe] resolver failed for", it.place_name, err);
        replaced = null;
      }
    }

    if (replaced) {
      const rebuilt = rebuildStopFromPoi(it, replaced);
      const newIdx = newTimelineRaw.length;
      newTimelineRaw.push(rebuilt);
      replacementByStopIndex.set(newIdx, {
        fromName: it.place_name,
        toName: rebuilt.place_name,
        coord: replaced.coord,
      });
      // Stamp the new POI so a third duplicate (if any) can't pick it again.
      const newKey = stopKey(rebuilt);
      if (newKey) seenKeys.add(newKey);
      anchor = replaced.coord;
      if (it.place_name !== rebuilt.place_name) {
        renames.set(it.place_name, rebuilt.place_name);
      }
      continue;
    }

    // No replacement — convert. For meals we use the explicit manual
    // confirmation placeholder when a resolver was provided (Amap reachable
    // but nothing usable returned), so the user knows it's not just a
    // generic suggestion.
    const useManual = !!(isMeal && resolver);
    const oldName = it.place_name;
    const hints = useManual && searchHintsFor ? searchHintsFor(it) : null;
    const converted = convertStopToDirectional(it, {
      mealManualConfirm: useManual,
      searchHints: hints || undefined,
    });
    convertedIndices.add(newTimelineRaw.length);
    newTimelineRaw.push(converted);
    if (converted.place_name !== oldName) {
      renames.set(oldName, converted.place_name);
    }
  }

  if (replacementByStopIndex.size === 0 && convertedIndices.size === 0) {
    return { plan, replacedCount: 0, convertedCount: 0 };
  }

  // Second pass: patch transport legs that fed any rewritten stop.
  type StopCoord = { name: string; coord?: AmapCoord };
  let prev: StopCoord = { name: "", coord: startCoord ?? undefined };
  const patched = newTimelineRaw.map((it, i) => {
    if (it.activity_type !== "transport") {
      if (it.lng != null && it.lat != null) {
        prev = { name: it.place_name, coord: { lng: it.lng, lat: it.lat } };
      } else {
        prev = { name: it.place_name, coord: prev.coord };
      }
      return it;
    }
    // Look ahead: is this leg feeding a replaced/converted stop?
    const repl = replacementByStopIndex.get(i + 1);
    const nextIsConverted = convertedIndices.has(i + 1);
    if (repl) {
      const newCoord = repl.coord;
      const navUrl = prev.coord
        ? buildAmapNavigationUrl(prev.coord, newCoord, repl.toName)
        : buildAmapMarkerUrl(repl.toName, newCoord);
      return {
        ...it,
        title: `前往${repl.toName}`,
        place_name: repl.toName,
        place_kind: "poi" as const,
        place_id: undefined,
        lng: newCoord.lng,
        lat: newCoord.lat,
        amap_url: navUrl,
        route_options: buildRouteOptions(
          prev.name || "起点",
          repl.toName,
          prev.coord,
          newCoord,
        ),
      };
    }
    if (nextIsConverted) {
      const target = newTimelineRaw[i + 1];
      const targetName = target.place_name;
      // If the converted stop carries a search URL, surface it on the
      // transport leg as a single "在高德搜索" affordance so the user can
      // open the same search from the leg too. Mode "search" keeps the UI
      // honest — it must NOT be styled like a verified driving/transit route.
      const isSearch = target.place_kind === "search" && !!target.search_url;
      return {
        ...it,
        title: `前往${targetName}`,
        place_name: targetName,
        place_id: undefined,
        place_kind: isSearch ? ("search" as const) : ("directional" as const),
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
      };
    }
    // Not adjacent to a rewrite. We deliberately do NOT rename by name here
    // — the legitimate first leg (which feeds the kept first stop) shares
    // its place_name with later duplicate stops, so a name-based rename
    // would incorrectly rewrite that good leg too. Only adjacent legs get
    // patched.
    return it;
  });

  // Patch route_chain: walk left-to-right and rename only the *later*
  // occurrences of a duplicate stop name (not the first). This mirrors how
  // we treat the timeline — the first stop with a given name is kept; later
  // occurrences point at the replacement / placeholder.
  const route_chain: RouteHop[] = (() => {
    if (renames.size === 0) return plan.route_chain;
    const seenStopFirstByName = new Map<string, boolean>();
    return plan.route_chain.map((hop) => {
      if (hop.kind === "stop") {
        const name = hop.from;
        const wasSeen = seenStopFirstByName.get(name) === true;
        if (!wasSeen) {
          seenStopFirstByName.set(name, true);
          return hop;
        }
        const renamed = renames.get(name);
        if (!renamed) return hop;
        return { ...hop, from: renamed, to: renamed };
      }
      // For legs, we only rewrite hops where `to` was the duplicated name
      // AND we have already passed its first stop (so this leg targets the
      // duplicate, not the kept original).
      const renamedTo =
        seenStopFirstByName.get(hop.to) === true ? renames.get(hop.to) : undefined;
      const renamedFrom =
        seenStopFirstByName.get(hop.from) === true ? renames.get(hop.from) : undefined;
      if (!renamedTo && !renamedFrom) return hop;
      return {
        ...hop,
        from: renamedFrom || hop.from,
        to: renamedTo || hop.to,
      };
    });
  })();

  return {
    plan: { ...plan, timeline: patched, route_chain },
    replacedCount: replacementByStopIndex.size,
    convertedCount: convertedIndices.size,
  };
}

/** Apply `repairPlanDuplicatesWithAmap` to every plan in a response. */
export async function repairResponseDuplicatesWithAmap(
  response: PlanResponse,
  resolver?: MealReplacementResolver | null,
  startCoord: AmapCoord | null = null,
  searchHintsFor?: ((duplicate: TimelineItem) => MealSearchHints | null | undefined) | null,
): Promise<{
  response: PlanResponse;
  replacedTotal: number;
  convertedTotal: number;
}> {
  let replacedTotal = 0;
  let convertedTotal = 0;
  const plans: Plan[] = [];
  for (const p of response.plans) {
    try {
      const r = await repairPlanDuplicatesWithAmap(p, resolver, startCoord, searchHintsFor);
      plans.push(r.plan);
      replacedTotal += r.replacedCount;
      convertedTotal += r.convertedCount;
    } catch (err) {
      console.warn("[plan-dedupe] async repair failed, keeping plan:", err);
      plans.push(p);
    }
  }
  if (replacedTotal === 0 && convertedTotal === 0) {
    return { response, replacedTotal: 0, convertedTotal: 0 };
  }
  // If we resolved any replacement via Amap, surface that in dataSources.
  let next = response;
  if (replacedTotal > 0) {
    const sources = new Set(response.dataSources.candidateSources || []);
    sources.add("amap");
    next = {
      ...response,
      dataSources: {
        ...response.dataSources,
        candidatesUsed: true,
        candidateSources: Array.from(sources),
      },
    };
  }
  return { response: { ...next, plans }, replacedTotal, convertedTotal };
}
