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
 * Convert a concrete-POI stop into a directional fallback in place. Strips
 * every field that could let the UI render a map link, marks the place_name
 * with the standard "方向建议，未绑定具体地点" tag, and preserves time / type.
 */
export function convertStopToDirectional(item: TimelineItem): TimelineItem {
  if (item.activity_type === "transport" || item.activity_type === "station_buffer") {
    return item;
  }
  const label =
    item.activity_type === "lunch" ? "午餐" :
    item.activity_type === "dinner" ? "晚餐" :
    item.activity_type === "coffee" ? "咖啡休息" :
    "推荐";
  const placeName = "方向建议，未绑定具体地点";
  return {
    ...item,
    title: `${label}：${placeName}`,
    place_name: placeName,
    place_id: undefined,
    place_kind: "directional",
    lng: undefined,
    lat: undefined,
    amap_url: undefined,
    candidate_score: undefined,
    candidate_reliability: undefined,
    source: "demo",
    reason: "已与同行程其他停留点重复，转为方向建议",
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
