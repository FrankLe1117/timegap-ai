/**
 * Demo-safe replacement of plan stops with real candidates from a CandidatePool.
 *
 * Strategy:
 * - Walk each plan's timeline. For non-transport, non-station_buffer stops,
 *   pick a category-appropriate candidate (restaurant→meal, cafe→coffee,
 *   scenic/indoor→attraction/city_walk, station_friendly→last meal near dest).
 * - Use simple heuristics (preference/category match, station-safety bonus,
 *   diversity), not an NP-hard optimizer.
 * - After replacement, recompute timeline times using Amap route estimates
 *   between candidate coords (with rush-hour surge), and rebuild route_chain.
 * - If the replacement violates safety (negative buffer, big buffer drop),
 *   revert to the original plan.
 *
 * Inputs/outputs are pure: the function takes a PlanResponse + CandidatePool
 * and returns a (possibly modified) PlanResponse. No I/O is done here other
 * than the route-estimate calls inside planner-route helpers.
 */
import { Candidate, CandidateCategory, CandidatePool } from "./candidate-pool";
import {
  Plan,
  PlanResponse,
  RouteHop,
  TimelineItem,
} from "@/types";
import {
  AmapCoord,
  buildAmapMarkerUrl,
  buildAmapNavigationUrl,
  buildAmapSearchUrl,
  estimateRoute,
  isAmapConfigured,
} from "./amap-client";

const RUSH_WINDOWS: Array<[number, number]> = [
  [450, 570],
  [1020, 1170],
];

function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minToTime(min: number): string {
  const safe = Math.max(0, Math.min(min, 60 * 24 - 1));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}
function isRushMin(min: number): boolean {
  return RUSH_WINDOWS.some(([a, b]) => min >= a && min <= b);
}
function rushSurge(min: number): number {
  return isRushMin(min) ? 1.4 : 1;
}

function activityToCategory(t: TimelineItem["activity_type"]): CandidateCategory | null {
  switch (t) {
    case "lunch":
    case "dinner":
      return "restaurant";
    case "coffee":
      return "cafe";
    case "city_walk":
      return "scenic";
    case "attraction":
      return "indoor";
    default:
      return null;
  }
}

/** Distance in km between two coords (Haversine). */
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

/**
 * Heuristically pick the best candidate for a slot.
 * - prefers high candidate.score
 * - prefers proximity to anchor (start of timeline) to keep travel short
 * - applies a tiny last-stop station-safety bonus when destCoord is given
 * - excludes already-used candidates for diversity
 */
function pickCandidateForSlot(
  candidates: Candidate[],
  used: Set<string>,
  anchor: AmapCoord | null,
  destCoord: AmapCoord | null,
  isLastStop: boolean,
): Candidate | null {
  const pool = candidates.filter((c) => !used.has(c.id));
  if (pool.length === 0) return null;
  const ranked = pool
    .map((c) => {
      let s = c.score;
      if (anchor) {
        const km = kmBetween(anchor, c.coord);
        s -= Math.min(km, 8) * 0.04; // mild distance penalty
      }
      if (isLastStop && destCoord) {
        const km = kmBetween(destCoord, c.coord);
        if (km < 4) s += 0.15;
        else if (km > 12) s -= 0.1;
      }
      return { c, s };
    })
    .sort((a, b) => b.s - a.s);
  return ranked[0]?.c || null;
}

interface ReplacementMark {
  /** Index in newTimeline where the candidate was placed (the stop item). */
  index: number;
  candidate: Candidate;
}

/**
 * Recompute the entire timeline using Amap route estimates between consecutive
 * coordinates. Falls back to the original transport durations when no
 * coordinate is available or when an estimate fails.
 */
async function rebuildTimelineWithCoords(
  original: TimelineItem[],
  startCoord: AmapCoord | null,
  destCoord: AmapCoord | null,
  startLocationName: string,
  destinationName: string,
): Promise<{ timeline: TimelineItem[]; chain: RouteHop[]; arrivalMin: number }> {
  // Reconstruct chronological "stops" + "transports" with their nominal coords.
  // Filter out station_buffer at end — we'll re-add it after.
  const tl = [...original];
  const stationBuffer = tl[tl.length - 1]?.activity_type === "station_buffer" ? tl.pop()! : null;

  // Build a list of stop entries (non-transport) with their stop durations.
  // The transports between them will be recomputed.
  type Stop = {
    item: TimelineItem;
    duration: number;
    coord?: AmapCoord;
  };
  const stops: Stop[] = [];
  // last item in tl after popping station_buffer is the final transport to dest
  let finalTransport: TimelineItem | null = null;
  if (tl.length && tl[tl.length - 1].activity_type === "transport" &&
      tl[tl.length - 1].place_name === destinationName) {
    finalTransport = tl.pop()!;
  }
  for (let i = 0; i < tl.length; i++) {
    const item = tl[i];
    if (item.activity_type === "transport") continue;
    const dur = timeToMin(item.end_time) - timeToMin(item.start_time);
    stops.push({
      item,
      duration: dur,
      coord:
        item.lng != null && item.lat != null
          ? { lng: item.lng, lat: item.lat }
          : undefined,
    });
  }

  const newTimeline: TimelineItem[] = [];
  const chain: RouteHop[] = [];
  let cursor = original[0] ? timeToMin(original[0].start_time) : 0;
  let prevCoord = startCoord;
  let prevName = startLocationName;

  for (const s of stops) {
    const toCoord = s.coord || null;
    let travelMin: number | null = null;
    let mode = s.item.travel_mode || "驾车/打车";
    if (prevCoord && toCoord && isAmapConfigured()) {
      const est = await estimateRoute(prevCoord, toCoord, "driving");
      if (est) {
        travelMin = Math.ceil(est.minutes * rushSurge(cursor));
        mode = "驾车/打车";
      }
    }
    if (travelMin == null) {
      // Fall back to the original transport duration if we have one.
      // Find the matching original transport leg for this stop name.
      const origLeg = original.find(
        (x) => x.activity_type === "transport" && x.place_name === s.item.place_name,
      );
      if (origLeg) travelMin = timeToMin(origLeg.end_time) - timeToMin(origLeg.start_time);
      else travelMin = 25;
    }

    const tStart = cursor;
    const tEnd = tStart + travelMin;
    // Build a navigation-style amap_url for the leg whose endpoint coords we
    // know. When only the destination coord is known we fall back to a marker
    // URL on that destination; without any coord we fall back to a keyword
    // search on the destination's displayed name. This keeps the leg's
    // amap_url consistent with the upcoming stop's identity.
    const transportAmapUrl = (() => {
      if (prevCoord && toCoord) {
        return buildAmapNavigationUrl(prevCoord, toCoord, s.item.place_name);
      }
      if (toCoord) return buildAmapMarkerUrl(s.item.place_name, toCoord);
      return buildAmapSearchUrl(s.item.place_name);
    })();
    const transportItem: TimelineItem = {
      start_time: minToTime(tStart),
      end_time: minToTime(tEnd),
      title: `前往${s.item.place_name}`,
      place_name: s.item.place_name,
      place_id: s.item.place_id,
      activity_type: "transport",
      reason: `${mode}，${isRushMin(tStart) ? "晚高峰，" : ""}预计${travelMin}分钟`,
      estimated_travel_time_to_next_min: null,
      travel_mode: mode,
      is_rush_hour: isRushMin(tStart),
      lng: toCoord?.lng,
      lat: toCoord?.lat,
      amap_url: transportAmapUrl,
    };
    newTimeline.push(transportItem);
    chain.push({
      from: prevName,
      to: s.item.place_name,
      travel_min: travelMin,
      mode,
      is_rush_hour: isRushMin(tStart),
      kind: "leg",
    });
    cursor = tEnd;

    const stopStart = cursor;
    const stopEnd = cursor + s.duration;
    // Preserve the replaced item's identity: name, coords, amap_url, source,
    // candidate_score all come from `s.item` (which already reflects the
    // candidate). We only refresh times here.
    const stopItem: TimelineItem = {
      ...s.item,
      start_time: minToTime(stopStart),
      end_time: minToTime(stopEnd),
      lng: toCoord?.lng ?? s.item.lng,
      lat: toCoord?.lat ?? s.item.lat,
    };
    newTimeline.push(stopItem);
    chain.push({
      from: s.item.place_name,
      to: s.item.place_name,
      travel_min: 0,
      kind: "stop",
      stop_duration_min: s.duration,
      activity_type: s.item.activity_type,
    });
    cursor = stopEnd;
    prevCoord = toCoord || prevCoord;
    prevName = s.item.place_name;
  }

  // Final transport to destination.
  const origFinal = finalTransport;
  let finalTravel: number | null = null;
  if (prevCoord && destCoord && isAmapConfigured()) {
    const est = await estimateRoute(prevCoord, destCoord, "driving");
    if (est) finalTravel = Math.ceil(est.minutes * rushSurge(cursor));
  }
  if (finalTravel == null) {
    finalTravel = origFinal
      ? timeToMin(origFinal.end_time) - timeToMin(origFinal.start_time)
      : 30;
  }
  const fStart = cursor;
  const fEnd = fStart + finalTravel;
  const finalAmapUrl = (() => {
    if (prevCoord && destCoord) return buildAmapNavigationUrl(prevCoord, destCoord, destinationName);
    if (destCoord) return buildAmapMarkerUrl(destinationName, destCoord);
    return origFinal?.amap_url || buildAmapSearchUrl(destinationName);
  })();
  newTimeline.push({
    start_time: minToTime(fStart),
    end_time: minToTime(fEnd),
    title: `前往${destinationName}`,
    place_name: destinationName,
    place_id: origFinal?.place_id,
    activity_type: "transport",
    reason: `${origFinal?.travel_mode || "驾车/打车"}，${isRushMin(fStart) ? "晚高峰，" : ""}预计${finalTravel}分钟`,
    estimated_travel_time_to_next_min: finalTravel,
    travel_mode: origFinal?.travel_mode || "驾车/打车",
    is_rush_hour: isRushMin(fStart),
    lng: destCoord?.lng,
    lat: destCoord?.lat,
    amap_url: finalAmapUrl,
  });
  chain.push({
    from: prevName,
    to: destinationName,
    travel_min: finalTravel,
    mode: origFinal?.travel_mode || "驾车/打车",
    is_rush_hour: isRushMin(fStart),
    kind: "leg",
  });
  cursor = fEnd;

  // Re-add station buffer up to original departure time. The buffer happens
  // at the destination, so its coords/url should track the destination — not
  // some stale name from before replacement.
  if (stationBuffer) {
    const departMin = timeToMin(stationBuffer.end_time);
    const bufferAmapUrl = destCoord
      ? buildAmapMarkerUrl(destinationName, destCoord)
      : stationBuffer.amap_url || buildAmapSearchUrl(destinationName);
    newTimeline.push({
      ...stationBuffer,
      start_time: minToTime(cursor),
      end_time: minToTime(Math.max(departMin, cursor)),
      lng: destCoord?.lng ?? stationBuffer.lng,
      lat: destCoord?.lat ?? stationBuffer.lat,
      amap_url: bufferAmapUrl,
    });
  }

  return { timeline: newTimeline, chain, arrivalMin: cursor };
}

/**
 * Apply candidate-pool replacements to a single plan.
 * Returns {plan, replaced} where `replaced` lists the swaps made (for UI/data).
 * On any safety violation, returns the original plan unchanged.
 */
async function applyToPlan(
  plan: Plan,
  pool: CandidatePool,
  startCoord: AmapCoord | null,
  destCoord: AmapCoord | null,
  startLocationName: string,
  destinationName: string,
  departureMinAbs: number,
  stationBufferMin: number,
): Promise<{ plan: Plan; replacedCount: number; sources: Set<"amap" | "meituan"> }> {
  const used = new Set<string>();
  const stops = plan.timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  if (stops.length === 0) return { plan, replacedCount: 0, sources: new Set() };

  const marks: ReplacementMark[] = [];
  const newTimeline: TimelineItem[] = plan.timeline.map((it) => ({ ...it }));

  let replacedCount = 0;
  for (let i = 0; i < newTimeline.length; i++) {
    const it = newTimeline[i];
    if (it.activity_type === "transport" || it.activity_type === "station_buffer") continue;

    // Determine if this stop is the last non-buffer stop in the plan.
    const isLastStop =
      stops[stops.length - 1].place_name === it.place_name &&
      stops[stops.length - 1].start_time === it.start_time;

    // Choose category: dinner+last-stop → station_friendly first, fall back to restaurant.
    let primary = activityToCategory(it.activity_type);
    if (!primary) continue;
    let candidates: Candidate[] = pool.byCategory[primary];
    if (it.activity_type === "dinner" && isLastStop && pool.byCategory.station_friendly.length) {
      candidates = pool.byCategory.station_friendly;
      primary = "station_friendly";
    }
    // Indoor fallback for attraction
    if (it.activity_type === "attraction" && candidates.length === 0) {
      candidates = pool.byCategory.scenic;
    }
    if (candidates.length === 0) continue;

    const pick = pickCandidateForSlot(candidates, used, startCoord, destCoord, isLastStop);
    if (!pick) continue;
    used.add(pick.id);

    // Build a fresh title that no longer references the original demo name.
    // If the original title contained the old place name (common), substitute
    // the candidate name; otherwise prepend the candidate name to keep the
    // displayed text and the underlying place identity in sync.
    const newTitle = it.title.includes(it.place_name)
      ? it.title.replace(it.place_name, pick.name)
      : pick.name;
    // The amap_url is derived from the candidate's own coord+name so the
    // navigation link always matches the displayed place. We build it here
    // (instead of letting enrich overwrite later) because enrichment runs
    // before replacement and would otherwise still point at the demo place.
    const candidateUrl = buildAmapMarkerUrl(pick.name, pick.coord);
    newTimeline[i] = {
      ...it,
      title: newTitle,
      place_name: pick.name,
      place_id: pick.id,
      lng: pick.coord.lng,
      lat: pick.coord.lat,
      source: pick.source,
      candidate_score: pick.score,
      amap_url: candidateUrl,
      reason: pick.district
        ? `${pick.district}・${primary === "station_friendly" ? "靠近车站候选" : "高德候选点"}`
        : `高德候选点（${primary}）`,
    };
    marks.push({ index: i, candidate: pick });
    replacedCount += 1;
  }

  if (replacedCount === 0) return { plan, replacedCount: 0, sources: new Set() };

  // Recompute timeline + chain using new coords.
  const rebuilt = await rebuildTimelineWithCoords(
    newTimeline,
    startCoord,
    destCoord,
    startLocationName,
    destinationName,
  );

  // Safety check: arrival must precede departure with a usable buffer.
  // If the new buffer is much worse than the original, revert.
  const originalArrival = (() => {
    const sb = plan.timeline.find((t) => t.activity_type === "station_buffer");
    return sb ? timeToMin(sb.start_time) : null;
  })();
  const newArrival = (() => {
    const sb = rebuilt.timeline.find((t) => t.activity_type === "station_buffer");
    return sb ? timeToMin(sb.start_time) : rebuilt.arrivalMin;
  })();

  const newBuffer = departureMinAbs - newArrival;
  // Hard fail: arrives after departure or buffer below 10 minutes when original had >=20.
  if (newBuffer < 0) {
    return { plan, replacedCount: 0, sources: new Set() };
  }
  if (originalArrival !== null) {
    const origBuffer = departureMinAbs - originalArrival;
    if (newBuffer < Math.min(origBuffer * 0.5, stationBufferMin / 2) && origBuffer > 15) {
      return { plan, replacedCount: 0, sources: new Set() };
    }
  }

  // Recompute scores: reward real candidates, penalize buffer drop.
  const tags = { ...plan.suitability_tags };
  // Experience boost: ~+2 per real-candidate stop, capped at +12, plus diversity bonus.
  const realStops = rebuilt.timeline.filter((t) => t.source && t.source !== "demo").length;
  const newCategories = new Set(
    rebuilt.timeline
      .filter((t) => t.source && t.source !== "demo")
      .map((t) => t.activity_type),
  );
  const diversityBonus = Math.min(newCategories.size, 3) * 2;
  tags.experience_score = Math.max(
    10,
    Math.min(100, Math.round(tags.experience_score + Math.min(realStops * 2, 12) + diversityBonus)),
  );

  // Station confidence: scale from buffer.
  if (newBuffer >= 30) {
    tags.station_arrival_confidence = Math.min(100, tags.station_arrival_confidence + 2);
  } else if (newBuffer >= 15) {
    tags.station_arrival_confidence = Math.max(10, tags.station_arrival_confidence - 5);
  } else {
    tags.station_arrival_confidence = Math.max(10, tags.station_arrival_confidence - 12);
  }

  const sources = new Set<"amap" | "meituan">();
  for (const m of marks) sources.add(m.candidate.source);

  const updatedPlan: Plan = {
    ...plan,
    timeline: rebuilt.timeline,
    route_chain: rebuilt.chain,
    suitability_tags: tags,
  };
  return { plan: updatedPlan, replacedCount, sources };
}

export interface ReplacementResult {
  response: PlanResponse;
  replacedTotal: number;
  sources: Array<"amap" | "meituan">;
}

/**
 * Apply candidate-pool replacements across all plans in the response.
 *
 * If the pool is unusable, the input is returned unchanged. Plans that fail
 * the safety check are reverted individually, so a single bad replacement
 * does not poison the entire response.
 */
export async function applyCandidatesToPlans(
  input: PlanResponse,
  pool: CandidatePool,
  anchors: { startCoord: AmapCoord | null; destCoord: AmapCoord | null },
): Promise<ReplacementResult> {
  if (!pool.hasRealData) {
    return { response: input, replacedTotal: 0, sources: [] };
  }

  const departureMin = (() => {
    const dep = input.parsedConstraints.departure_time;
    return timeToMin(dep);
  })();
  const stationBuffer = input.timeBudget.station_buffer_min;

  const newPlans: Plan[] = [];
  let replacedTotal = 0;
  const allSources = new Set<"amap" | "meituan">();

  for (const plan of input.plans) {
    try {
      const r = await applyToPlan(
        plan,
        pool,
        anchors.startCoord,
        anchors.destCoord,
        input.parsedConstraints.start_location,
        input.parsedConstraints.final_destination,
        departureMin,
        stationBuffer,
      );
      newPlans.push(r.plan);
      replacedTotal += r.replacedCount;
      r.sources.forEach((s) => allSources.add(s));
    } catch (err) {
      console.warn("[planner-replace] plan replacement failed, keeping original:", err);
      newPlans.push(plan);
    }
  }

  return {
    response: {
      ...input,
      plans: newPlans,
      dataSources: {
        ...input.dataSources,
        candidatesUsed: replacedTotal > 0,
        candidateSources: Array.from(allSources),
      },
    },
    replacedTotal,
    sources: Array.from(allSources),
  };
}
