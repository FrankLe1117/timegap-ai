/**
 * Post-processes a PlanResponse with Amap data when AMAP_API_KEY is configured.
 *
 * - Resolves coordinates for each timeline place via geocode/POI search.
 * - For each transport leg, attempts an Amap route estimate and replaces the
 *   demo travel minutes (with rush-hour surge re-applied).
 * - Adds an Amap navigation URL to each non-transport stop and to transport
 *   legs.
 * - Updates `dataSources` to surface what actually happened.
 *
 * On any failure or missing key, returns the input plan unchanged so the
 * existing demo path keeps working.
 */

import {
  AmapPoi,
  buildAmapMarkerUrl,
  buildAmapNavigationUrl,
  buildAmapSearchUrl,
  buildRouteOptions,
  estimateRoute,
  geocodePlace,
  isAmapConfigured,
} from "./amap-client";
import { Plan, PlanResponse, RouteHop, TimelineItem } from "@/types";
import { cityNameForAmap } from "./city-detect";

const ENRICHMENT_BUDGET_MS = 6000;

function timeToMin(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(min: number): string {
  const safe = Math.max(0, Math.min(min, 60 * 24 - 1));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function rushSurge(timeMin: number): number {
  // Mirror planner's rush-hour windows (450–570, 1020–1170) with a 1.4x bump.
  if ((timeMin >= 450 && timeMin <= 570) || (timeMin >= 1020 && timeMin <= 1170)) return 1.4;
  return 1;
}

interface ResolveCache {
  cache: Map<string, AmapPoi | null>;
  /** Cumulative milliseconds spent so far; used to bail out gracefully. */
  start: number;
}

function exceededBudget(c: ResolveCache): boolean {
  return Date.now() - c.start > ENRICHMENT_BUDGET_MS;
}

async function resolvePlace(name: string, c: ResolveCache, city: string): Promise<AmapPoi | null> {
  if (!name) return null;
  const cached = c.cache.get(name);
  if (cached !== undefined) return cached;
  if (exceededBudget(c)) {
    c.cache.set(name, null);
    return null;
  }
  const poi = await geocodePlace(name, city);
  c.cache.set(name, poi);
  return poi;
}

export async function enrichPlanWithAmap(input: PlanResponse): Promise<PlanResponse> {
  if (!isAmapConfigured()) return input;

  const cache: ResolveCache = { cache: new Map(), start: Date.now() };
  const city =
    input.parsedConstraints.city_cn ||
    cityNameForAmap(input.parsedConstraints.city);

  let totalLegs = 0;
  let amapLegs = 0;

  const enrichedPlans: Plan[] = [];

  for (const plan of input.plans) {
    const newTimeline: TimelineItem[] = [];
    let prevPlace = input.parsedConstraints.start_location;
    let prevPoi = await resolvePlace(prevPlace, cache, city);

    // We mutate by walking the timeline sequentially; each transport leg may
    // shift downstream times if we replace the duration. We track a delta so
    // later items stay consistent.
    let deltaMin = 0;

    for (let i = 0; i < plan.timeline.length; i++) {
      const item = plan.timeline[i];
      const adjustedStart = timeToMin(item.start_time) + deltaMin;
      const originalDur = timeToMin(item.end_time) - timeToMin(item.start_time);

      if (item.activity_type === "transport") {
        totalLegs += 1;
        // If the leg's destination already has trusted coords from a real
        // candidate, use them directly; otherwise geocode by name.
        const itemHasTrustedCoords =
          item.source && item.source !== "demo" && item.lng != null && item.lat != null;
        const toPoi = itemHasTrustedCoords
          ? { id: item.place_id || `cand:${item.place_name}`, name: item.place_name, coord: { lng: item.lng!, lat: item.lat! } }
          : await resolvePlace(item.place_name, cache, city);
        let newDur = originalDur;
        let amapHit = false;
        if (prevPoi && toPoi) {
          const est = await estimateRoute(prevPoi.coord, toPoi.coord, "driving");
          if (est) {
            const start = adjustedStart;
            const surge = rushSurge(start);
            newDur = Math.ceil(est.minutes * surge);
            amapHit = true;
            amapLegs += 1;
          }
        }
        const startStr = minToTime(adjustedStart);
        const endStr = minToTime(adjustedStart + newDur);
        const updated: TimelineItem = {
          ...item,
          start_time: startStr,
          end_time: endStr,
          reason: amapHit
            ? `${item.travel_mode || "驾车/打车"}，高德路线估算约${newDur}分钟${item.is_rush_hour ? "（晚高峰已加权）" : ""}`
            : item.reason,
          lng: toPoi?.coord.lng,
          lat: toPoi?.coord.lat,
          amap_url:
            prevPoi && toPoi
              ? buildAmapNavigationUrl(prevPoi.coord, toPoi.coord, item.place_name)
              : toPoi
                ? buildAmapMarkerUrl(item.place_name, toPoi.coord)
                : buildAmapSearchUrl(item.place_name),
          route_options: buildRouteOptions(prevPlace, item.place_name, prevPoi?.coord, toPoi?.coord),
        };
        newTimeline.push(updated);
        deltaMin += newDur - originalDur;
        if (toPoi) {
          prevPoi = toPoi;
          prevPlace = item.place_name;
        }
      } else {
        const startStr = minToTime(adjustedStart);
        const endStr = minToTime(adjustedStart + originalDur);
        // If this stop already came from a real candidate (Amap/Meituan) and
        // has its own coords, trust them: do NOT geocode the name again. A
        // name like "上海柏悦酒店" can geocode to an unrelated POI and
        // silently desync coords/url from the displayed name.
        const isResolvedCandidate =
          item.source && item.source !== "demo" && item.lng != null && item.lat != null;
        const poi = isResolvedCandidate
          ? null
          : item.activity_type === "station_buffer"
            ? prevPoi
            : await resolvePlace(item.place_name, cache, city);
        const stopLng = isResolvedCandidate ? item.lng : poi?.coord.lng;
        const stopLat = isResolvedCandidate ? item.lat : poi?.coord.lat;
        const stopAmapUrl = isResolvedCandidate
          ? item.amap_url ||
            (item.lng != null && item.lat != null
              ? buildAmapMarkerUrl(item.place_name, { lng: item.lng, lat: item.lat })
              : buildAmapSearchUrl(item.place_name))
          : poi
            ? buildAmapMarkerUrl(item.place_name, poi.coord)
            : buildAmapSearchUrl(item.place_name);
        const updated: TimelineItem = {
          ...item,
          start_time: startStr,
          end_time: endStr,
          lng: stopLng,
          lat: stopLat,
          amap_url: stopAmapUrl,
        };
        newTimeline.push(updated);
        if (isResolvedCandidate && item.lng != null && item.lat != null) {
          prevPoi = { id: item.place_id || `cand:${item.place_name}`, name: item.place_name, coord: { lng: item.lng, lat: item.lat } };
          prevPlace = item.place_name;
        } else if (poi && item.activity_type !== "station_buffer") {
          prevPoi = poi;
          prevPlace = item.place_name;
        }
      }
    }

    // Rebuild route_chain mirroring the new timeline so legs match the
    // possibly-updated travel minutes.
    const newChain: RouteHop[] = [];
    for (const item of newTimeline) {
      if (item.activity_type === "transport") {
        const min = timeToMin(item.end_time) - timeToMin(item.start_time);
        const last = [...newChain].reverse().find((h) => h.kind === "stop");
        const fromName = last?.from || input.parsedConstraints.start_location;
        newChain.push({
          from: fromName,
          to: item.place_name,
          travel_min: min,
          mode: item.travel_mode,
          is_rush_hour: item.is_rush_hour,
          kind: "leg",
        });
      } else if (item.activity_type === "station_buffer") {
        // skip
      } else {
        newChain.push({
          from: item.place_name,
          to: item.place_name,
          travel_min: 0,
          kind: "stop",
          stop_duration_min: timeToMin(item.end_time) - timeToMin(item.start_time),
          activity_type: item.activity_type,
        });
      }
    }

    enrichedPlans.push({ ...plan, timeline: newTimeline, route_chain: newChain });
  }

  let routesSource: PlanResponse["dataSources"]["routesSource"] = "demo";
  if (totalLegs > 0 && amapLegs === totalLegs) routesSource = "amap";
  else if (amapLegs > 0) routesSource = "mixed";

  return {
    ...input,
    plans: enrichedPlans,
    dataSources: {
      ...input.dataSources,
      amapConfigured: true,
      routesSource,
      travelTimes:
        routesSource === "amap"
          ? "高德路线估算（含晚高峰加权）"
          : routesSource === "mixed"
            ? "高德路线估算 + 演示交通图（部分路段）"
            : "演示交通图（高德 API 未命中，已回退）",
      places: "演示城市地点库 + 高德地理编码（用于坐标/导航链接）",
      apiReady:
        routesSource === "amap" || routesSource === "mixed"
          ? "已接入高德 Web Service（路线/POI/地理编码），未接入点评/美团"
          : input.dataSources.apiReady,
    },
  };
}
