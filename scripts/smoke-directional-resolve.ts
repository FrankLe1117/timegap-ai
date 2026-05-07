/**
 * Smoke test for the directional-suggestion resolver.
 *
 * After place-sanitize converts a synthetic demo stop into a directional
 * suggestion ("黄浦区附近找一家老字号餐厅小馆（方向建议）"), the resolver
 * should:
 *   1. Extract intent (area + cuisine + activity).
 *   2. Run a couple of Amap searches via injected mocks.
 *   3. Replace the directional stop with a concrete POI when the search
 *      returns a reliable result (real id, address, matching type, near
 *      anchor, non-synthetic name).
 *   4. Leave the stop directional when the search returns a weak result
 *      (e.g. synthesized id, generic name) or nothing at all.
 *
 * Also asserts:
 *   - When AMAP_API_KEY is unset and no `deps` are injected, the resolver
 *     returns the input unchanged.
 *   - Transport leg titles + route_chain hops referencing the directional
 *     stop are rewritten to the resolved POI.
 *
 * Run via `npm run smoke:directional` (and bundled into `npm run smoke`).
 */
import {
  buildIntentQueries,
  buildMealFallbackQueries,
  extractDirectionalIntent,
  isPoiReliableForActivity,
  resolveDirectionalStop,
  resolveDirectionalSuggestions,
  resolveMealReplacement,
  type AmapSearchDeps,
} from "../src/lib/directional-resolver";
import { sanitizePlanResponse } from "../src/lib/place-sanitize";
import type { AmapPoi } from "../src/lib/amap-client";
import {
  repairPlanDuplicates,
  repairPlanDuplicatesWithAmap,
  repairResponseDuplicates,
  repairResponseDuplicatesWithAmap,
  stopKey,
} from "../src/lib/plan-dedupe";
import type { Plan, PlanResponse, TimelineItem } from "../src/types";

function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("PASS:", msg);
}

async function main() {

/* ------------------------------------------------------------------------- */
/* 1. Intent extraction                                                       */
/* ------------------------------------------------------------------------- */

const directionalDinner: TimelineItem = {
  start_time: "18:30",
  end_time: "19:30",
  title: "晚餐：黄浦区附近找一家老字号餐厅小馆",
  place_name: "黄浦区附近找一家老字号餐厅小馆（方向建议）",
  activity_type: "dinner",
  reason: "演示版未绑定具体店铺，已转为方向建议",
  estimated_travel_time_to_next_min: null,
  place_kind: "directional",
  source: "demo",
};

const intent = extractDirectionalIntent(directionalDinner);
ok(intent.area === "黄浦区", `intent.area === "黄浦区" (got ${intent.area})`);
ok(intent.category === "老字号餐厅", `intent.category === "老字号餐厅" (got ${intent.category})`);
ok(intent.activity === "dinner", "intent.activity preserved");

const queries = buildIntentQueries(intent);
ok(queries.length >= 2, `built >=2 intent queries (got ${queries.length})`);
ok(queries[0].includes("黄浦区"), `top query mentions 黄浦区: ${queries[0]}`);
ok(
  queries.some((q) => q.includes("老字号")),
  "queries include 老字号 tokenization",
);

/* ------------------------------------------------------------------------- */
/* 2. Reliability gate                                                       */
/* ------------------------------------------------------------------------- */

const confirmedPoi: AmapPoi = {
  id: "B0FFGPX001",
  name: "上海老饭店",
  address: "黄浦区福佑路242号",
  coord: { lng: 121.493, lat: 31.227 },
  type: "餐饮服务;中餐厅;本帮江浙菜",
  district: "黄浦区",
  hasRealId: true,
};
ok(
  isPoiReliableForActivity(confirmedPoi, "dinner", { lng: 121.49, lat: 31.23 }),
  "real POI with id/address/type passes reliability gate",
);

const weakPoiNoId: AmapPoi = {
  id: "poi:本帮菜",
  name: "本帮菜",
  address: "",
  coord: { lng: 121.493, lat: 31.227 },
  type: "餐饮服务;中餐厅",
  hasRealId: false,
};
ok(!isPoiReliableForActivity(weakPoiNoId, "dinner"), "synthesized id POI rejected");

const weakPoiSynthName: AmapPoi = {
  id: "B0FFGPXabc",
  name: "黄浦区餐厅",
  address: "黄浦区某路1号",
  coord: { lng: 121.493, lat: 31.227 },
  type: "餐饮服务",
  hasRealId: true,
};
ok(
  !isPoiReliableForActivity(weakPoiSynthName, "dinner"),
  "synthetic-shaped name rejected even with real id",
);

const wrongType: AmapPoi = {
  id: "B0FFGPXxyz",
  name: "上海博物馆",
  address: "黄浦区人民大道201号",
  coord: { lng: 121.481, lat: 31.232 },
  type: "科教文化服务;博物馆;博物馆",
  hasRealId: true,
};
ok(!isPoiReliableForActivity(wrongType, "dinner"), "non-restaurant type rejected for dinner");

/* ------------------------------------------------------------------------- */
/* 3. End-to-end PlanResponse with mocks                                     */
/* ------------------------------------------------------------------------- */

function buildResponse(stop: TimelineItem): PlanResponse {
  // Single plan with a transport→stop sequence so we can also verify
  // the transport leg gets patched.
  const transport: TimelineItem = {
    start_time: "17:30",
    end_time: "18:00",
    title: `前往${stop.place_name}`,
    place_name: stop.place_name,
    activity_type: "transport",
    reason: "驾车/打车，预计30分钟",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const plan: Plan = {
    plan_name: "测试方案",
    plan_type: "balanced",
    one_sentence_summary: "",
    tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High",
      rush_hour_exposure: "Low",
      walking_intensity: "Low",
      local_experience: "High",
      luggage_friendly: "High",
      weather_robustness: "High",
      station_arrival_confidence: 80,
      experience_score: 70,
    },
    timeline: [transport, stop],
    route_chain: [
      { from: "起点", to: stop.place_name, travel_min: 30, kind: "leg", mode: "驾车/打车" },
      {
        from: stop.place_name,
        to: stop.place_name,
        travel_min: 0,
        kind: "stop",
        stop_duration_min: 60,
        activity_type: stop.activity_type,
      },
    ],
    latest_leave_for_station: "20:00",
    risk_note: "",
    backup_suggestion: "",
    explanation: "",
  };
  return {
    parsedConstraints: {
      city: "上海",
      start_location: "外滩",
      start_time: "17:00",
      final_destination: "虹桥火车站",
      departure_time: "21:00",
      preferences: ["local_food"],
      constraints: [],
      budget_per_person: null,
      luggage: false,
      weather: "unknown",
      walking_preference: "medium",
      food_preference: ["本帮菜"],
      plan_style: "balanced",
    },
    timeBudget: {
      free_window_min: 240,
      station_buffer_min: 45,
      planning_deadline: "20:00",
      estimated_final_transfer_min: 30,
      latest_leave_for_station: "20:00",
      safe_activity_time_min: 200,
      rush_hour_detected: false,
      rush_hour_note: "",
    },
    plans: [plan],
    dataSources: {
      places: "演示城市地点库",
      travelTimes: "演示交通图",
      apiReady: "未接入高德",
      routesSource: "demo",
      amapConfigured: true,
    },
  };
}

function makeDeps(pois: AmapPoi[]): AmapSearchDeps {
  let calls = 0;
  return {
    searchByKeyword: async () => {
      calls += 1;
      return pois;
    },
    searchNearby: async () => {
      calls += 1;
      return pois;
    },
    // Expose call count for sanity checking via closure (not part of the
    // interface but visible in this file).
    // @ts-expect-error -- debug field
    _calls: () => calls,
  };
}

// 3a. Confirmed POI replaces directional stop.
{
  const resp = buildResponse(directionalDinner);
  const deps = makeDeps([confirmedPoi]);
  const { response, resolvedTotal } = await resolveDirectionalSuggestions(resp, {
    startCoord: { lng: 121.49, lat: 31.23 },
    deps,
  });
  ok(resolvedTotal === 1, `resolvedTotal === 1 (got ${resolvedTotal})`);
  const stops = response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  ok(stops.length === 1, "still exactly one stop after resolution");
  const s = stops[0];
  ok(s.place_name === "上海老饭店", `place_name updated to POI name (got ${s.place_name})`);
  ok(s.place_kind === "poi", "place_kind upgraded to poi");
  ok(s.amap_url && s.amap_url.includes("uri.amap.com"), "amap_url present");
  ok(s.lng === confirmedPoi.coord.lng && s.lat === confirmedPoi.coord.lat, "coords match POI");
  ok(s.source === "amap", "source recorded as amap");
  ok(s.candidate_reliability === "confirmed", "reliability stamped confirmed");

  // Transport leg also patched.
  const leg = response.plans[0].timeline.find((t) => t.activity_type === "transport")!;
  ok(leg.place_name === "上海老饭店", `transport leg follows new name (got ${leg.place_name})`);
  ok(leg.title === "前往上海老饭店", `transport title updated (got ${leg.title})`);
  ok(leg.place_kind === "poi", "transport leg place_kind upgraded");
  ok(!!leg.amap_url, "transport leg has amap_url");

  // route_chain renamed.
  const stopHop = response.plans[0].route_chain.find((h) => h.kind === "stop")!;
  ok(stopHop.from === "上海老饭店" && stopHop.to === "上海老饭店", "route_chain stop hop renamed");
  const legHop = response.plans[0].route_chain.find((h) => h.kind === "leg")!;
  ok(legHop.to === "上海老饭店", "route_chain leg hop target renamed");

  // Data source flag updated.
  ok(response.dataSources.candidatesUsed === true, "dataSources.candidatesUsed = true");
  ok(
    (response.dataSources.candidateSources || []).includes("amap"),
    "dataSources.candidateSources includes amap",
  );
}

// 3b. Weak POI (Amap reachable but nothing usable) -> meal directional gets
//      upgraded to the explicit "需要手动确认餐馆" manual-confirm placeholder.
//      The transport leg is repointed at the new placeholder and stripped of
//      any nav affordance.
{
  const resp = buildResponse(directionalDinner);
  const deps = makeDeps([weakPoiNoId, weakPoiSynthName]);
  const { response, resolvedTotal, manualConfirmTotal } = await resolveDirectionalSuggestions(resp, {
    startCoord: { lng: 121.49, lat: 31.23 },
    deps,
  });
  ok(resolvedTotal === 0, `resolvedTotal === 0 when only weak POIs returned (got ${resolvedTotal})`);
  ok(manualConfirmTotal === 1, `manualConfirmTotal === 1 (got ${manualConfirmTotal})`);
  const stops = response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  const s = stops[0];
  ok(s.place_kind === "directional", "stop remains directional");
  ok(!s.amap_url, "stop has no amap_url");
  ok(s.lng == null && s.lat == null, "stop has no coords");
  ok(s.place_name === "需要手动确认餐馆", `place_name upgraded to manual confirm (got ${s.place_name})`);
  ok(!/方向建议/.test(s.place_name), "place_name no longer reads as generic 方向建议");
  ok(s.title === "晚餐：需要手动确认餐馆", `title rewritten (got ${s.title})`);
  // Transport leg follows the rewrite, with no fake map link.
  const leg = response.plans[0].timeline.find((t) => t.activity_type === "transport")!;
  ok(leg.place_name === "需要手动确认餐馆", `transport leg place_name updated (got ${leg.place_name})`);
  ok(leg.title === "前往需要手动确认餐馆", `transport title updated (got ${leg.title})`);
  ok(!leg.amap_url, "transport leg has no amap_url");
  ok(!leg.lng && !leg.lat, "transport leg coords cleared");
  // Pure manual-confirm pass should not flip dataSources.candidatesUsed.
  ok(response.dataSources.candidatesUsed !== true, "manual-confirm: candidatesUsed not flipped on");
}

// 3c. Empty POI list -> meal directional upgraded to manual confirm.
{
  const resp = buildResponse(directionalDinner);
  const deps = makeDeps([]);
  const { response, resolvedTotal, manualConfirmTotal } = await resolveDirectionalSuggestions(resp, {
    startCoord: { lng: 121.49, lat: 31.23 },
    deps,
  });
  ok(resolvedTotal === 0, "resolvedTotal === 0 with no POIs");
  ok(manualConfirmTotal === 1, `manualConfirmTotal === 1 (got ${manualConfirmTotal})`);
  const s = response.plans[0].timeline.find((t) => t.activity_type === "dinner")!;
  ok(s.place_kind === "directional", "stop stays directional with empty results");
  ok(s.place_name === "需要手动确认餐馆", `place_name upgraded (got ${s.place_name})`);
}

// 3d. No-AMAP-key path: when isAmapConfigured() is false AND deps default to
// the live client, the resolver returns the input unchanged. We exercise this
// by ensuring the env var is unset and not passing `deps`.
{
  const prev = process.env.AMAP_API_KEY;
  delete process.env.AMAP_API_KEY;
  try {
    const resp = buildResponse(directionalDinner);
    const { response, resolvedTotal } = await resolveDirectionalSuggestions(resp, {
      startCoord: null,
    });
    ok(resolvedTotal === 0, "no-key path: resolvedTotal === 0");
    ok(response === resp, "no-key path: response identity preserved");
  } finally {
    if (prev !== undefined) process.env.AMAP_API_KEY = prev;
  }
}

// 3e. Coffee directional: must match cafe-type only.
const directionalCoffee: TimelineItem = {
  start_time: "15:30",
  end_time: "16:30",
  title: "咖啡休息：武康路附近找一家咖啡馆",
  place_name: "武康路附近找一家咖啡馆休息（方向建议）",
  activity_type: "coffee",
  reason: "演示版未绑定具体店铺，已转为方向建议",
  estimated_travel_time_to_next_min: null,
  place_kind: "directional",
  source: "demo",
};
{
  // Restaurant-typed POI must NOT satisfy a coffee directional.
  const restaurantPoi: AmapPoi = {
    id: "B0FFGPXccc",
    name: "武康庭餐厅",
    address: "武康路某号",
    coord: { lng: 121.42, lat: 31.20 },
    type: "餐饮服务;中餐厅",
    hasRealId: true,
  };
  ok(
    !isPoiReliableForActivity(restaurantPoi, "coffee"),
    "restaurant-type POI rejected for coffee activity",
  );
  // Real cafe POI passes.
  const cafePoi: AmapPoi = {
    id: "B0FFGPXddd",
    name: "%Arabica 武康路店",
    address: "武康路378号",
    coord: { lng: 121.42, lat: 31.20 },
    type: "餐饮服务;咖啡厅;咖啡厅",
    hasRealId: true,
  };
  ok(
    isPoiReliableForActivity(cafePoi, "coffee", { lng: 121.42, lat: 31.20 }),
    "cafe-type POI passes for coffee activity",
  );

  const resp = buildResponse(directionalCoffee);
  const deps = makeDeps([restaurantPoi, cafePoi]);
  const { resolvedTotal, response } = await resolveDirectionalSuggestions(resp, {
    startCoord: { lng: 121.42, lat: 31.20 },
    deps,
  });
  ok(resolvedTotal === 1, "coffee directional resolved (skipped wrong-type, picked cafe)");
  const s = response.plans[0].timeline.find((t) => t.activity_type === "coffee")!;
  ok(s.place_name === "%Arabica 武康路店", `coffee stop replaced with cafe POI`);
  ok(s.place_kind === "poi", "coffee stop place_kind=poi");
}

/* ------------------------------------------------------------------------- */
/* 4. Plan-level dedupe                                                      */
/* ------------------------------------------------------------------------- */

// Helper: build a 2-stop plan response (lunch + dinner) where both slots
// start as directional suggestions. Used for the "two directionals resolve
// to the same POI" scenario.
function buildLunchDinnerResponse(): PlanResponse {
  const lunch: TimelineItem = {
    start_time: "12:00",
    end_time: "13:00",
    title: "午餐：黄浦区附近找一家老字号餐厅小馆",
    place_name: "黄浦区附近找一家老字号餐厅小馆（方向建议）",
    activity_type: "lunch",
    reason: "演示版未绑定具体店铺，已转为方向建议",
    estimated_travel_time_to_next_min: null,
    place_kind: "directional",
    source: "demo",
  };
  const dinner: TimelineItem = {
    start_time: "18:30",
    end_time: "19:30",
    title: "晚餐：黄浦区附近找一家老字号餐厅小馆",
    place_name: "黄浦区附近找一家老字号餐厅小馆（方向建议）",
    activity_type: "dinner",
    reason: "演示版未绑定具体店铺，已转为方向建议",
    estimated_travel_time_to_next_min: null,
    place_kind: "directional",
    source: "demo",
  };
  const transportLunch: TimelineItem = {
    start_time: "11:30",
    end_time: "12:00",
    title: `前往${lunch.place_name}`,
    place_name: lunch.place_name,
    activity_type: "transport",
    reason: "驾车/打车，预计30分钟",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const transportDinner: TimelineItem = {
    start_time: "18:00",
    end_time: "18:30",
    title: `前往${dinner.place_name}`,
    place_name: dinner.place_name,
    activity_type: "transport",
    reason: "驾车/打车，预计30分钟",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const plan: Plan = {
    plan_name: "测试方案",
    plan_type: "balanced",
    one_sentence_summary: "",
    tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High",
      rush_hour_exposure: "Low",
      walking_intensity: "Low",
      local_experience: "High",
      luggage_friendly: "High",
      weather_robustness: "High",
      station_arrival_confidence: 80,
      experience_score: 70,
    },
    timeline: [transportLunch, lunch, transportDinner, dinner],
    route_chain: [
      { from: "起点", to: lunch.place_name, travel_min: 30, kind: "leg", mode: "驾车/打车" },
      {
        from: lunch.place_name,
        to: lunch.place_name,
        travel_min: 0,
        kind: "stop",
        stop_duration_min: 60,
        activity_type: lunch.activity_type,
      },
      { from: lunch.place_name, to: dinner.place_name, travel_min: 30, kind: "leg", mode: "驾车/打车" },
      {
        from: dinner.place_name,
        to: dinner.place_name,
        travel_min: 0,
        kind: "stop",
        stop_duration_min: 60,
        activity_type: dinner.activity_type,
      },
    ],
    latest_leave_for_station: "21:00",
    risk_note: "",
    backup_suggestion: "",
    explanation: "",
  };
  return {
    parsedConstraints: {
      city: "上海",
      start_location: "外滩",
      start_time: "11:00",
      final_destination: "虹桥火车站",
      departure_time: "21:00",
      preferences: ["local_food"],
      constraints: [],
      budget_per_person: null,
      luggage: false,
      weather: "unknown",
      walking_preference: "medium",
      food_preference: ["本帮菜"],
      plan_style: "balanced",
    },
    timeBudget: {
      free_window_min: 600,
      station_buffer_min: 45,
      planning_deadline: "20:00",
      estimated_final_transfer_min: 30,
      latest_leave_for_station: "20:00",
      safe_activity_time_min: 540,
      rush_hour_detected: false,
      rush_hour_note: "",
    },
    plans: [plan],
    dataSources: {
      places: "演示城市地点库",
      travelTimes: "演示交通图",
      apiReady: "未接入高德",
      routesSource: "demo",
      amapConfigured: true,
    },
  };
}

const onlyConfirmedPoi: AmapPoi = {
  id: "B0FFGPX001",
  name: "上海老饭店",
  address: "黄浦区福佑路242号",
  coord: { lng: 121.493, lat: 31.227 },
  type: "餐饮服务;中餐厅;本帮江浙菜",
  district: "黄浦区",
  hasRealId: true,
};

// 4a. Two directional stops, one reliable POI: only the first slot wins, the
//     second stays directional with no map link.
{
  const resp = buildLunchDinnerResponse();
  const deps = makeDeps([onlyConfirmedPoi]);
  const { response, resolvedTotal } = await resolveDirectionalSuggestions(resp, {
    startCoord: { lng: 121.49, lat: 31.23 },
    deps,
  });
  ok(resolvedTotal === 1, `dedupe: only one slot resolved (got ${resolvedTotal})`);
  const stops = response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  const concrete = stops.filter((s) => s.place_kind === "poi");
  ok(concrete.length === 1, `dedupe: exactly one concrete POI in plan (got ${concrete.length})`);
  ok(concrete[0].place_name === onlyConfirmedPoi.name, "dedupe: earlier slot kept the POI");

  const directional = stops.filter((s) => s.place_kind === "directional");
  ok(directional.length === 1, `dedupe: later slot stayed directional (got ${directional.length})`);
  ok(!directional[0].amap_url, "dedupe: directional fallback has no amap_url");
  ok(directional[0].lng == null && directional[0].lat == null, "dedupe: directional fallback has no coords");

  // No transport title 前往<same place> linking the two identical concrete stops.
  const transports = response.plans[0].timeline.filter((t) => t.activity_type === "transport");
  const dupTransport = transports.find((t) => t.place_name === onlyConfirmedPoi.name && t.title === `前往${onlyConfirmedPoi.name}`);
  // Only the first slot's transport leg may title 前往<上海老饭店>; not both.
  const transportTitles = transports.map((t) => t.title);
  const sameTitleCount = transportTitles.filter((t) => t === `前往${onlyConfirmedPoi.name}`).length;
  ok(sameTitleCount <= 1, `dedupe: at most one transport titled 前往${onlyConfirmedPoi.name} (got ${sameTitleCount})`);
  // Sanity: that single transport (if any) feeds the concrete stop, not the directional one.
  if (dupTransport) {
    const idx = response.plans[0].timeline.indexOf(dupTransport);
    const next = response.plans[0].timeline[idx + 1];
    ok(next && next.place_name === onlyConfirmedPoi.name, "dedupe: dup-named transport feeds the concrete stop");
  }
}

// 4b. First Amap result is a duplicate of the lunch slot, second is reliable
//     and distinct: resolver should pick the second for the dinner slot.
{
  const resp = buildLunchDinnerResponse();
  const altPoi: AmapPoi = {
    id: "B0FFGPX002",
    name: "绿波廊",
    address: "黄浦区豫园路115号",
    coord: { lng: 121.491, lat: 31.226 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  // Lunch sees [confirmedPoi]. Dinner sees [confirmedPoi (duplicate), altPoi].
  let call = 0;
  const deps: AmapSearchDeps = {
    searchByKeyword: async () => {
      call += 1;
      return call <= 1 ? [onlyConfirmedPoi] : [onlyConfirmedPoi, altPoi];
    },
    searchNearby: async () => {
      call += 1;
      return call <= 1 ? [onlyConfirmedPoi] : [onlyConfirmedPoi, altPoi];
    },
  };
  const { response, resolvedTotal } = await resolveDirectionalSuggestions(resp, {
    startCoord: { lng: 121.49, lat: 31.23 },
    deps,
  });
  ok(resolvedTotal === 2, `alt-pick: both slots resolved (got ${resolvedTotal})`);
  const stops = response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  const names = stops.map((s) => s.place_name);
  ok(names.includes(onlyConfirmedPoi.name), "alt-pick: lunch kept first POI");
  ok(names.includes(altPoi.name), "alt-pick: dinner picked alternate POI");
  ok(new Set(names).size === stops.length, "alt-pick: all stop names are distinct");
}

// 4c. Repair guard: a plan that arrives with two identical concrete POIs
//     (e.g. enrichment + earlier resolution drift) should be repaired.
{
  const sharedStop: TimelineItem = {
    start_time: "12:00",
    end_time: "13:00",
    title: `午餐：${onlyConfirmedPoi.name}`,
    place_name: onlyConfirmedPoi.name,
    place_id: onlyConfirmedPoi.id,
    activity_type: "lunch",
    reason: "高德验证",
    estimated_travel_time_to_next_min: null,
    lng: onlyConfirmedPoi.coord.lng,
    lat: onlyConfirmedPoi.coord.lat,
    amap_url: "https://uri.amap.com/marker?dummy",
    source: "amap",
    candidate_reliability: "confirmed",
    place_kind: "poi",
  };
  const dupStop: TimelineItem = { ...sharedStop, start_time: "18:30", end_time: "19:30", title: `晚餐：${onlyConfirmedPoi.name}`, activity_type: "dinner" };
  const transport1: TimelineItem = {
    start_time: "11:30",
    end_time: "12:00",
    title: `前往${onlyConfirmedPoi.name}`,
    place_name: onlyConfirmedPoi.name,
    activity_type: "transport",
    reason: "驾车/打车",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
    lng: onlyConfirmedPoi.coord.lng,
    lat: onlyConfirmedPoi.coord.lat,
    amap_url: "https://uri.amap.com/nav?dummy",
  };
  const transport2: TimelineItem = { ...transport1, start_time: "18:00", end_time: "18:30" };
  const dupPlan: Plan = {
    plan_name: "重复方案",
    plan_type: "balanced",
    one_sentence_summary: "",
    tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High", rush_hour_exposure: "Low", walking_intensity: "Low",
      local_experience: "High", luggage_friendly: "High", weather_robustness: "High",
      station_arrival_confidence: 80, experience_score: 70,
    },
    timeline: [transport1, sharedStop, transport2, dupStop],
    route_chain: [
      { from: "起点", to: onlyConfirmedPoi.name, travel_min: 30, kind: "leg" },
      { from: onlyConfirmedPoi.name, to: onlyConfirmedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "lunch" },
      { from: onlyConfirmedPoi.name, to: onlyConfirmedPoi.name, travel_min: 30, kind: "leg" },
      { from: onlyConfirmedPoi.name, to: onlyConfirmedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "dinner" },
    ],
    latest_leave_for_station: "21:00",
    risk_note: "",
    backup_suggestion: "",
    explanation: "",
  };
  const { plan: repaired, convertedCount } = repairPlanDuplicates(dupPlan);
  ok(convertedCount === 1, `repair: converted exactly one duplicate (got ${convertedCount})`);
  const stops = repaired.timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  ok(stops[0].place_kind === "poi", "repair: first concrete stop kept");
  ok(stops[0].place_name === onlyConfirmedPoi.name, "repair: first concrete stop name unchanged");
  ok(stops[1].place_kind === "directional", "repair: second stop converted to directional");
  ok(!stops[1].amap_url, "repair: directional fallback dropped amap_url");
  ok(stops[1].lng == null && stops[1].lat == null, "repair: directional fallback dropped coords");
  ok(/方向建议/.test(stops[1].place_name), `repair: place_name marked directional (got ${stops[1].place_name})`);

  // The transport leg that fed the duplicate stop must no longer title
  // 前往<onlyConfirmedPoi.name>; it should now point at the directional name.
  const lastTransport = repaired.timeline.filter((t) => t.activity_type === "transport").pop()!;
  ok(lastTransport.place_name !== onlyConfirmedPoi.name, "repair: trailing transport leg name updated");
  ok(lastTransport.title !== `前往${onlyConfirmedPoi.name}`, "repair: trailing transport title is no longer 前往<同一家店>");
  ok(lastTransport.place_kind === "directional", "repair: trailing transport place_kind=directional");
  ok(!lastTransport.amap_url, "repair: trailing transport amap_url stripped");

  // Sanity: the converted stop no longer keys to the same POI as the kept one.
  // Directional fallbacks intentionally have no dedupe key (stopKey returns
  // null) so a future second resolution pass treats them as fresh slots.
  const k0 = stopKey(stops[0]);
  const k1 = stopKey(stops[1]);
  ok(!!k0 && k1 == null, `repair: kept stop has key, converted stop has none (k0=${k0}, k1=${k1})`);
}

// 4d. repairResponseDuplicates is a pure no-op when there are no duplicates.
{
  const resp = buildResponse(directionalDinner);
  const { response, convertedTotal } = repairResponseDuplicates(resp);
  ok(convertedTotal === 0, "repair-response: no-op when no duplicates");
  ok(response === resp, "repair-response: identity preserved on no-op");
}

/* ------------------------------------------------------------------------- */
/* 5. Restaurant fallback search                                              */
/* ------------------------------------------------------------------------- */

// 5a. buildMealFallbackQueries widens the search beyond the intent category.
{
  const lunchIntent = {
    area: "人民广场",
    category: "餐厅" as string,
    activity: "lunch" as TimelineItem["activity_type"],
  };
  const queries = buildMealFallbackQueries(lunchIntent, ["本帮菜"]);
  ok(queries.length >= 3, `meal-fallback: at least 3 queries (got ${queries.length})`);
  ok(
    queries.some((q) => q.includes("本帮菜")),
    "meal-fallback: includes 本帮菜 cuisine hint",
  );
  ok(
    queries.some((q) => q.includes("人民广场")),
    "meal-fallback: includes area in queries",
  );
  // Coffee branch uses cafe-specific tokens.
  const coffeeIntent = {
    area: "武康路",
    category: "咖啡",
    activity: "coffee" as TimelineItem["activity_type"],
  };
  const coffeeQueries = buildMealFallbackQueries(coffeeIntent, []);
  ok(
    coffeeQueries.some((q) => q.includes("咖啡")),
    "meal-fallback: coffee branch keeps coffee tokens",
  );
}

// 5b. Pass-2 fallback fires when pass-1 returns nothing reliable. Simulate
//     by returning weak POIs for the intent queries and a real one for the
//     fallback queries.
{
  const realLunchPoi: AmapPoi = {
    id: "B0FFGRX001",
    name: "上海德兴馆(广东路店)",
    address: "黄浦区广东路471号",
    coord: { lng: 121.481, lat: 31.234 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  let calls = 0;
  const deps: AmapSearchDeps = {
    // Pass-1 uses radius<=2500 / limit<=5; pass-2 uses radius=4000 / limit=10.
    // Returning POIs only on the wider-radius call proves we're hitting the
    // fallback path (not just a different intent query).
    searchByKeyword: async (_q, _city, limit) => {
      calls += 1;
      return (limit && limit >= 10) ? [realLunchPoi] : [];
    },
    searchNearby: async (_anchor, _q, radius, limit) => {
      calls += 1;
      return (radius && radius >= 4000) || (limit && limit >= 10)
        ? [realLunchPoi]
        : [];
    },
  };
  const intent = {
    area: "人民广场",
    category: "餐厅",
    activity: "lunch" as TimelineItem["activity_type"],
  };
  const pick = await resolveDirectionalStop(
    intent,
    { lng: 121.48, lat: 31.23 },
    "上海",
    deps,
    new Set<string>(),
    { cuisineHints: ["本帮菜"] },
  );
  ok(pick !== null, "meal-fallback: pass-2 finds a real POI when pass-1 returns nothing");
  ok(pick && pick.name === realLunchPoi.name, `meal-fallback: picked real POI (got ${pick && pick.name})`);
  ok(calls >= 2, `meal-fallback: at least two search rounds (got ${calls})`);
}

/* ------------------------------------------------------------------------- */
/* 6. Amap-aware duplicate repair                                             */
/* ------------------------------------------------------------------------- */

// 6a. Duplicate restaurant gets *replaced* with a different concrete POI when
//     a resolver returns one (instead of being converted to directional).
{
  const sharedPoi: AmapPoi = {
    id: "B0FFGRX001",
    name: "上海老饭店",
    address: "黄浦区福佑路242号",
    coord: { lng: 121.493, lat: 31.227 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  const altPoi: AmapPoi = {
    id: "B0FFGRX002",
    name: "绿波廊",
    address: "黄浦区豫园路115号",
    coord: { lng: 121.492, lat: 31.226 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  const lunchStop: TimelineItem = {
    start_time: "12:00",
    end_time: "13:00",
    title: `午餐：${sharedPoi.name}`,
    place_name: sharedPoi.name,
    place_id: sharedPoi.id,
    activity_type: "lunch",
    reason: "高德验证",
    estimated_travel_time_to_next_min: null,
    lng: sharedPoi.coord.lng,
    lat: sharedPoi.coord.lat,
    amap_url: "https://uri.amap.com/marker?dummy",
    source: "amap",
    candidate_reliability: "confirmed",
    place_kind: "poi",
  };
  const dinnerStop: TimelineItem = { ...lunchStop, start_time: "18:30", end_time: "19:30", title: `晚餐：${sharedPoi.name}`, activity_type: "dinner" };
  const transport1: TimelineItem = {
    start_time: "11:30",
    end_time: "12:00",
    title: `前往${sharedPoi.name}`,
    place_name: sharedPoi.name,
    activity_type: "transport",
    reason: "驾车/打车",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const transport2: TimelineItem = { ...transport1, start_time: "18:00", end_time: "18:30" };
  const dupPlan: Plan = {
    plan_name: "重复方案",
    plan_type: "balanced",
    one_sentence_summary: "",
    tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High", rush_hour_exposure: "Low", walking_intensity: "Low",
      local_experience: "High", luggage_friendly: "High", weather_robustness: "High",
      station_arrival_confidence: 80, experience_score: 70,
    },
    timeline: [transport1, lunchStop, transport2, dinnerStop],
    route_chain: [
      { from: "起点", to: sharedPoi.name, travel_min: 30, kind: "leg" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "lunch" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 30, kind: "leg" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "dinner" },
    ],
    latest_leave_for_station: "21:00",
    risk_note: "",
    backup_suggestion: "",
    explanation: "",
  };
  const { plan: repaired, replacedCount, convertedCount } = await repairPlanDuplicatesWithAmap(
    dupPlan,
    async () => altPoi,
    { lng: 121.49, lat: 31.23 },
  );
  ok(replacedCount === 1, `amap-repair: replaced exactly one duplicate (got ${replacedCount})`);
  ok(convertedCount === 0, `amap-repair: nothing converted to directional (got ${convertedCount})`);
  const stops = repaired.timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  ok(stops.length === 2, "amap-repair: still two stops");
  ok(stops[0].place_name === sharedPoi.name, "amap-repair: first stop kept");
  ok(stops[1].place_name === altPoi.name, `amap-repair: dup stop replaced with alt POI (got ${stops[1].place_name})`);
  ok(stops[1].place_kind === "poi", "amap-repair: replaced stop is a poi");
  ok(!!stops[1].amap_url, "amap-repair: replaced stop has amap_url");
  ok(stops[1].lng === altPoi.coord.lng && stops[1].lat === altPoi.coord.lat, "amap-repair: replaced stop has alt coords");
  ok(stops[1].source === "amap", "amap-repair: replaced stop source=amap");
  // Transport leg titles updated coherently.
  const transports = repaired.timeline.filter((t) => t.activity_type === "transport");
  const lastTransport = transports[transports.length - 1];
  ok(lastTransport.place_name === altPoi.name, `amap-repair: transport leg name updated (got ${lastTransport.place_name})`);
  ok(lastTransport.title === `前往${altPoi.name}`, `amap-repair: transport leg title updated (got ${lastTransport.title})`);
  ok(lastTransport.place_kind === "poi", "amap-repair: transport leg place_kind=poi");
  ok(!!lastTransport.amap_url, "amap-repair: transport leg has amap_url");
  // No self-loop: transport from to differs.
  ok(transports[0].place_name !== transports[1].place_name, "amap-repair: no identical adjacent transport titles for both meals");
}

// 6b. When resolver returns null, duplicate falls back to the explicit
//     "需要手动确认餐馆" placeholder (not a fake suggestion, no map link).
{
  const sharedPoi: AmapPoi = {
    id: "B0FFGRX001",
    name: "上海老饭店",
    address: "黄浦区福佑路242号",
    coord: { lng: 121.493, lat: 31.227 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  const lunchStop: TimelineItem = {
    start_time: "12:00",
    end_time: "13:00",
    title: `午餐：${sharedPoi.name}`,
    place_name: sharedPoi.name,
    place_id: sharedPoi.id,
    activity_type: "lunch",
    reason: "高德验证",
    estimated_travel_time_to_next_min: null,
    lng: sharedPoi.coord.lng,
    lat: sharedPoi.coord.lat,
    amap_url: "https://uri.amap.com/marker?dummy",
    source: "amap",
    candidate_reliability: "confirmed",
    place_kind: "poi",
  };
  const dinnerStop: TimelineItem = { ...lunchStop, start_time: "18:30", end_time: "19:30", title: `晚餐：${sharedPoi.name}`, activity_type: "dinner" };
  const transport1: TimelineItem = {
    start_time: "11:30",
    end_time: "12:00",
    title: `前往${sharedPoi.name}`,
    place_name: sharedPoi.name,
    activity_type: "transport",
    reason: "驾车/打车",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const transport2: TimelineItem = { ...transport1, start_time: "18:00", end_time: "18:30" };
  const dupPlan: Plan = {
    plan_name: "重复方案",
    plan_type: "balanced",
    one_sentence_summary: "",
    tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High", rush_hour_exposure: "Low", walking_intensity: "Low",
      local_experience: "High", luggage_friendly: "High", weather_robustness: "High",
      station_arrival_confidence: 80, experience_score: 70,
    },
    timeline: [transport1, lunchStop, transport2, dinnerStop],
    route_chain: [
      { from: "起点", to: sharedPoi.name, travel_min: 30, kind: "leg" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "lunch" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 30, kind: "leg" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "dinner" },
    ],
    latest_leave_for_station: "21:00",
    risk_note: "",
    backup_suggestion: "",
    explanation: "",
  };
  const { plan: repaired, replacedCount, convertedCount } = await repairPlanDuplicatesWithAmap(
    dupPlan,
    async () => null,
    { lng: 121.49, lat: 31.23 },
  );
  ok(replacedCount === 0, `manual-fallback: nothing replaced (got ${replacedCount})`);
  ok(convertedCount === 1, `manual-fallback: one converted to manual placeholder (got ${convertedCount})`);
  const stops = repaired.timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  ok(stops[0].place_name === sharedPoi.name, "manual-fallback: first stop kept");
  ok(stops[1].place_kind === "directional", "manual-fallback: dup converted to directional");
  ok(/手动确认餐馆/.test(stops[1].place_name), `manual-fallback: place_name uses manual-confirm copy (got ${stops[1].place_name})`);
  ok(!/方向建议/.test(stops[1].place_name), `manual-fallback: place_name does NOT use generic directional copy (got ${stops[1].place_name})`);
  ok(!stops[1].amap_url, "manual-fallback: no amap_url on placeholder");
  ok(stops[1].lng == null && stops[1].lat == null, "manual-fallback: no coords on placeholder");
  ok(/手动选择|未在高德/.test(stops[1].reason || ""), `manual-fallback: reason explains why (got ${stops[1].reason})`);
  // Transport leg fed into the dup must not still title "前往<同一家店>".
  const transports = repaired.timeline.filter((t) => t.activity_type === "transport");
  const lastTransport = transports[transports.length - 1];
  ok(lastTransport.place_name !== sharedPoi.name, "manual-fallback: trailing transport name updated");
  ok(!lastTransport.amap_url, "manual-fallback: trailing transport amap_url stripped");
  ok(lastTransport.place_kind === "directional", "manual-fallback: trailing transport place_kind=directional");
}

// 6c. Coffee duplicate also routes through the meal/coffee branch (uses
//     manual-confirm copy when no resolver result).
{
  const cafePoi: AmapPoi = {
    id: "B0FFGRX003",
    name: "%Arabica 武康路店",
    address: "武康路378号",
    coord: { lng: 121.42, lat: 31.20 },
    type: "餐饮服务;咖啡厅;咖啡厅",
    district: "徐汇区",
    hasRealId: true,
  };
  const coffeeStop1: TimelineItem = {
    start_time: "10:00",
    end_time: "10:30",
    title: `咖啡休息：${cafePoi.name}`,
    place_name: cafePoi.name,
    place_id: cafePoi.id,
    activity_type: "coffee",
    reason: "高德验证",
    estimated_travel_time_to_next_min: null,
    lng: cafePoi.coord.lng,
    lat: cafePoi.coord.lat,
    amap_url: "https://uri.amap.com/marker?dummy",
    source: "amap",
    candidate_reliability: "confirmed",
    place_kind: "poi",
  };
  const coffeeStop2: TimelineItem = { ...coffeeStop1, start_time: "15:00", end_time: "15:30" };
  const transport1: TimelineItem = {
    start_time: "09:30", end_time: "10:00",
    title: `前往${cafePoi.name}`, place_name: cafePoi.name,
    activity_type: "transport", reason: "驾车/打车",
    estimated_travel_time_to_next_min: null, travel_mode: "驾车/打车",
  };
  const transport2: TimelineItem = { ...transport1, start_time: "14:30", end_time: "15:00" };
  const dupPlan: Plan = {
    plan_name: "重复方案", plan_type: "balanced",
    one_sentence_summary: "", tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High", rush_hour_exposure: "Low", walking_intensity: "Low",
      local_experience: "High", luggage_friendly: "High", weather_robustness: "High",
      station_arrival_confidence: 80, experience_score: 70,
    },
    timeline: [transport1, coffeeStop1, transport2, coffeeStop2],
    route_chain: [
      { from: "起点", to: cafePoi.name, travel_min: 15, kind: "leg" },
      { from: cafePoi.name, to: cafePoi.name, travel_min: 0, kind: "stop", stop_duration_min: 30, activity_type: "coffee" },
      { from: cafePoi.name, to: cafePoi.name, travel_min: 30, kind: "leg" },
      { from: cafePoi.name, to: cafePoi.name, travel_min: 0, kind: "stop", stop_duration_min: 30, activity_type: "coffee" },
    ],
    latest_leave_for_station: "21:00", risk_note: "", backup_suggestion: "", explanation: "",
  };
  const { plan: repaired } = await repairPlanDuplicatesWithAmap(
    dupPlan,
    async () => null,
    null,
  );
  const stops = repaired.timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  ok(/手动确认咖啡馆/.test(stops[1].place_name), `coffee-manual: uses cafe-specific manual copy (got ${stops[1].place_name})`);
}

// 6d. Without a resolver, repairPlanDuplicatesWithAmap behaves like the sync
//     repair (every duplicate becomes a generic directional placeholder).
{
  const sharedPoi: AmapPoi = {
    id: "B0FFGRX001",
    name: "上海老饭店",
    address: "黄浦区福佑路242号",
    coord: { lng: 121.493, lat: 31.227 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  const lunch: TimelineItem = {
    start_time: "12:00", end_time: "13:00",
    title: `午餐：${sharedPoi.name}`, place_name: sharedPoi.name,
    place_id: sharedPoi.id, activity_type: "lunch",
    reason: "高德验证", estimated_travel_time_to_next_min: null,
    lng: sharedPoi.coord.lng, lat: sharedPoi.coord.lat,
    amap_url: "https://uri.amap.com/marker?dummy",
    source: "amap", candidate_reliability: "confirmed", place_kind: "poi",
  };
  const dinner: TimelineItem = { ...lunch, start_time: "18:30", end_time: "19:30", activity_type: "dinner", title: `晚餐：${sharedPoi.name}` };
  const tx1: TimelineItem = {
    start_time: "11:30", end_time: "12:00",
    title: `前往${sharedPoi.name}`, place_name: sharedPoi.name,
    activity_type: "transport", reason: "驾车", estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const tx2: TimelineItem = { ...tx1, start_time: "18:00", end_time: "18:30" };
  const plan: Plan = {
    plan_name: "p", plan_type: "balanced", one_sentence_summary: "", tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High", rush_hour_exposure: "Low", walking_intensity: "Low",
      local_experience: "High", luggage_friendly: "High", weather_robustness: "High",
      station_arrival_confidence: 80, experience_score: 70,
    },
    timeline: [tx1, lunch, tx2, dinner],
    route_chain: [
      { from: "起点", to: sharedPoi.name, travel_min: 30, kind: "leg" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "lunch" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 30, kind: "leg" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "dinner" },
    ],
    latest_leave_for_station: "21:00", risk_note: "", backup_suggestion: "", explanation: "",
  };
  const { plan: repaired, replacedCount, convertedCount } = await repairPlanDuplicatesWithAmap(plan, null, null);
  ok(replacedCount === 0, "no-resolver: nothing replaced");
  ok(convertedCount === 1, "no-resolver: one converted to directional");
  const stops = repaired.timeline.filter((t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer");
  ok(/方向建议/.test(stops[1].place_name) && !/手动确认/.test(stops[1].place_name), `no-resolver: uses generic directional copy (got ${stops[1].place_name})`);
}

// 6e. resolveMealReplacement is a thin wrapper that respects usedKeys.
{
  const realPoi: AmapPoi = {
    id: "B0FFXXX",
    name: "Manner Coffee(南京东路店)",
    address: "南京东路200号",
    coord: { lng: 121.49, lat: 31.24 },
    type: "餐饮服务;咖啡厅;咖啡厅",
    district: "黄浦区",
    hasRealId: true,
  };
  const deps: AmapSearchDeps = {
    searchByKeyword: async () => [realPoi],
    searchNearby: async () => [realPoi],
  };
  const used = new Set<string>([`id:${realPoi.id}`]);
  const skip = await resolveMealReplacement({
    activity: "coffee",
    anchor: { lng: 121.49, lat: 31.24 },
    usedKeys: used,
    deps,
  });
  ok(skip === null, "resolveMealReplacement: skips POI already in usedKeys");
  const used2 = new Set<string>();
  const pick = await resolveMealReplacement({
    activity: "coffee",
    anchor: { lng: 121.49, lat: 31.24 },
    usedKeys: used2,
    deps,
  });
  ok(pick && pick.id === realPoi.id, "resolveMealReplacement: picks real POI when free");
}

// 6f. End-to-end response-level repair: duplicate restaurant in a sanitized
//     PlanResponse gets replaced with a different concrete POI, and the
//     dataSources.candidatesUsed flag flips on.
{
  const sharedPoi: AmapPoi = {
    id: "B0FFGRX001",
    name: "上海老饭店",
    address: "黄浦区福佑路242号",
    coord: { lng: 121.493, lat: 31.227 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  const altPoi: AmapPoi = {
    id: "B0FFGRX002",
    name: "绿波廊",
    address: "黄浦区豫园路115号",
    coord: { lng: 121.491, lat: 31.226 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  const lunch: TimelineItem = {
    start_time: "12:00", end_time: "13:00",
    title: `午餐：${sharedPoi.name}`, place_name: sharedPoi.name,
    place_id: sharedPoi.id, activity_type: "lunch",
    reason: "高德验证", estimated_travel_time_to_next_min: null,
    lng: sharedPoi.coord.lng, lat: sharedPoi.coord.lat,
    amap_url: "https://uri.amap.com/marker?dummy",
    source: "amap", candidate_reliability: "confirmed", place_kind: "poi",
  };
  const dinner: TimelineItem = { ...lunch, start_time: "18:30", end_time: "19:30", title: `晚餐：${sharedPoi.name}`, activity_type: "dinner" };
  const tx1: TimelineItem = {
    start_time: "11:30", end_time: "12:00",
    title: `前往${sharedPoi.name}`, place_name: sharedPoi.name,
    activity_type: "transport", reason: "驾车", estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const tx2: TimelineItem = { ...tx1, start_time: "18:00", end_time: "18:30" };
  const plan: Plan = {
    plan_name: "p", plan_type: "balanced", one_sentence_summary: "", tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High", rush_hour_exposure: "Low", walking_intensity: "Low",
      local_experience: "High", luggage_friendly: "High", weather_robustness: "High",
      station_arrival_confidence: 80, experience_score: 70,
    },
    timeline: [tx1, lunch, tx2, dinner],
    route_chain: [
      { from: "起点", to: sharedPoi.name, travel_min: 30, kind: "leg" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "lunch" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 30, kind: "leg" },
      { from: sharedPoi.name, to: sharedPoi.name, travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "dinner" },
    ],
    latest_leave_for_station: "21:00", risk_note: "", backup_suggestion: "", explanation: "",
  };
  const resp: PlanResponse = {
    parsedConstraints: {
      city: "上海", start_location: "外滩", start_time: "11:00",
      final_destination: "虹桥火车站", departure_time: "21:00",
      preferences: ["local_food"], constraints: [], budget_per_person: null,
      luggage: false, weather: "unknown", walking_preference: "medium",
      food_preference: ["本帮菜"], plan_style: "balanced",
    },
    timeBudget: {
      free_window_min: 600, station_buffer_min: 45,
      planning_deadline: "20:00", estimated_final_transfer_min: 30,
      latest_leave_for_station: "20:00", safe_activity_time_min: 540,
      rush_hour_detected: false, rush_hour_note: "",
    },
    plans: [plan],
    dataSources: {
      places: "高德", travelTimes: "高德",
      apiReady: "高德 web service", routesSource: "amap", amapConfigured: true,
    },
  };
  const { response, replacedTotal, convertedTotal } = await repairResponseDuplicatesWithAmap(
    resp,
    async ({ usedKeys }) => {
      // Honor usedKeys: skip sharedPoi if it's already in.
      if (usedKeys.has(`id:${altPoi.id}`)) return null;
      return altPoi;
    },
    { lng: 121.49, lat: 31.23 },
  );
  ok(replacedTotal === 1, `e2e-repair: replacedTotal=1 (got ${replacedTotal})`);
  ok(convertedTotal === 0, `e2e-repair: convertedTotal=0 (got ${convertedTotal})`);
  const stops = response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  ok(stops[0].place_name === sharedPoi.name, "e2e-repair: lunch kept original");
  ok(stops[1].place_name === altPoi.name, "e2e-repair: dinner replaced with alt POI");
  ok(stops[1].place_kind === "poi", "e2e-repair: dinner stop is poi");
  ok((response.dataSources.candidateSources || []).includes("amap"), "e2e-repair: candidateSources includes amap");
  ok(response.dataSources.candidatesUsed === true, "e2e-repair: candidatesUsed=true");
}

/* ------------------------------------------------------------------------- */
/* 7. Screenshot regression: 人民广场附近找一家本帮菜小馆 with raw tag reason  */
/* ------------------------------------------------------------------------- */

// Reproduces the exact UI bug shown in the bug report screenshot:
//   - meal stop name "人民广场附近找一家本帮菜小馆"
//   - reason field carrying raw planner tags "#local_food #budget #quick_meal"
//   - transport segment titled 前往人民广场附近找一家本帮菜小馆（方向建议）
//
// After resolveDirectionalSuggestions runs (Amap mocked), we expect:
//   - With a reliable POI candidate: stop becomes concrete POI + transport
//     leg follows the new POI name.
//   - With no reliable candidate: stop becomes "晚餐：需要手动确认餐馆"
//     (no fake map link, no raw tag reason); transport segment also rewritten
//     to "前往需要手动确认餐馆".

function buildScreenshotResponse(): PlanResponse {
  // The screenshot's stop, fed through the planner's pre-sanitize state — i.e.
  // a raw demo restaurant with the tag-style reason. After sanitizePlanResponse
  // it becomes a directional. We assert the post-sanitize state too.
  const rawDinner: TimelineItem = {
    start_time: "18:30",
    end_time: "19:30",
    title: "晚餐：人民广场小吃与本帮简餐",
    place_name: "人民广场小吃与本帮简餐",
    place_id: "food_people_snack",
    activity_type: "dinner",
    // Exactly what planner.ts emits from node.tags.slice(0,3).map(t=>"#"+t).join(" ")
    reason: "#local_food #budget #quick_meal",
    estimated_travel_time_to_next_min: null,
    source: "demo",
  };
  const transport: TimelineItem = {
    start_time: "18:00",
    end_time: "18:30",
    title: `前往${rawDinner.place_name}`,
    place_name: rawDinner.place_name,
    activity_type: "transport",
    reason: "驾车/打车，预计30分钟",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const plan: Plan = {
    plan_name: "测试方案",
    plan_type: "balanced",
    one_sentence_summary: "",
    tradeoff_summary: "",
    suitability_tags: {
      time_safety: "High", rush_hour_exposure: "Low", walking_intensity: "Low",
      local_experience: "High", luggage_friendly: "High", weather_robustness: "High",
      station_arrival_confidence: 80, experience_score: 70,
    },
    timeline: [transport, rawDinner],
    route_chain: [
      { from: "起点", to: rawDinner.place_name, travel_min: 30, kind: "leg", mode: "驾车/打车" },
      {
        from: rawDinner.place_name, to: rawDinner.place_name,
        travel_min: 0, kind: "stop", stop_duration_min: 60, activity_type: "dinner",
      },
    ],
    latest_leave_for_station: "21:00",
    risk_note: "", backup_suggestion: "", explanation: "",
  };
  return {
    parsedConstraints: {
      city: "上海", start_location: "外滩", start_time: "17:00",
      final_destination: "虹桥火车站", departure_time: "21:00",
      preferences: ["local_food"], constraints: [], budget_per_person: null,
      luggage: false, weather: "unknown", walking_preference: "medium",
      food_preference: ["本帮菜"], plan_style: "balanced",
    },
    timeBudget: {
      free_window_min: 240, station_buffer_min: 45,
      planning_deadline: "20:15", estimated_final_transfer_min: 30,
      latest_leave_for_station: "20:00", safe_activity_time_min: 200,
      rush_hour_detected: false, rush_hour_note: "",
    },
    plans: [plan],
    dataSources: {
      places: "演示城市地点库", travelTimes: "演示交通图",
      apiReady: "未接入高德", routesSource: "demo", amapConfigured: true,
    },
  };
}

// 7a. Sanitize-only behavior: tag-style reason MUST be replaced.
{
  const raw = buildScreenshotResponse();
  const sanitized = sanitizePlanResponse(raw, () => "人民广场");
  const dinner = sanitized.plans[0].timeline.find((t) => t.activity_type === "dinner")!;
  ok(dinner.place_kind === "directional", "screenshot/sanitize: dinner is directional");
  ok(/方向建议/.test(dinner.place_name), "screenshot/sanitize: place_name carries 方向建议 tail");
  ok(dinner.place_name.includes("人民广场"), "screenshot/sanitize: place_name keeps area hint");
  ok(
    !/^#[A-Za-z0-9_]+(\s+#[A-Za-z0-9_]+)+$/.test(dinner.reason || ""),
    `screenshot/sanitize: reason is not a raw tag string (got ${dinner.reason})`,
  );
  ok(
    dinner.reason === "演示版未绑定具体店铺，已转为方向建议",
    `screenshot/sanitize: reason replaced with user-facing string (got ${dinner.reason})`,
  );
  // Transport leg after sanitize should also follow the new directional name.
  const leg = sanitized.plans[0].timeline.find((t) => t.activity_type === "transport")!;
  ok(/方向建议/.test(leg.place_name), "screenshot/sanitize: transport place_name carries 方向建议");
  ok(leg.title.startsWith("前往"), "screenshot/sanitize: transport title prefixed 前往");
}

// 7b. Concrete POI available: directional resolver upgrades to POI; transport
//      leg follows. No "方向建议" leakage anywhere.
{
  const raw = buildScreenshotResponse();
  const sanitized = sanitizePlanResponse(raw, () => "人民广场");
  const realPoi: AmapPoi = {
    id: "B0FFKB1234",
    name: "上海老饭店(人民广场店)",
    address: "黄浦区福州路88号",
    coord: { lng: 121.474, lat: 31.231 },
    type: "餐饮服务;中餐厅;本帮江浙菜",
    district: "黄浦区",
    hasRealId: true,
  };
  const deps = makeDeps([realPoi]);
  const { response, resolvedTotal, manualConfirmTotal } =
    await resolveDirectionalSuggestions(sanitized, {
      startCoord: { lng: 121.48, lat: 31.23 },
      deps,
      cuisineHints: ["本帮菜"],
    });
  ok(resolvedTotal === 1, `screenshot/poi: resolvedTotal=1 (got ${resolvedTotal})`);
  ok(manualConfirmTotal === 0, "screenshot/poi: manualConfirmTotal=0");
  const dinner = response.plans[0].timeline.find((t) => t.activity_type === "dinner")!;
  ok(dinner.place_kind === "poi", "screenshot/poi: dinner upgraded to poi");
  ok(dinner.place_name === realPoi.name, `screenshot/poi: place_name=${realPoi.name}`);
  ok(!/方向建议/.test(dinner.place_name), "screenshot/poi: no 方向建议 in name");
  ok(!/找一家.*小馆/.test(dinner.place_name), "screenshot/poi: no generic 找一家XX小馆 phrase");
  ok(!!dinner.amap_url, "screenshot/poi: dinner has amap_url");
  // Transport leg also follows.
  const leg = response.plans[0].timeline.find((t) => t.activity_type === "transport")!;
  ok(leg.place_name === realPoi.name, `screenshot/poi: transport place_name updated`);
  ok(leg.title === `前往${realPoi.name}`, `screenshot/poi: transport title updated`);
  ok(!/方向建议/.test(leg.place_name), "screenshot/poi: transport no 方向建议");
  ok(!/找一家.*小馆/.test(leg.place_name), "screenshot/poi: transport no 找一家XX小馆");
}

// 7c. No reliable POI: dinner stop becomes "晚餐：需要手动确认餐馆", transport
//      leg becomes "前往需要手动确认餐馆", no map link, no fabricated phrase.
{
  const raw = buildScreenshotResponse();
  const sanitized = sanitizePlanResponse(raw, () => "人民广场");
  const deps = makeDeps([]); // Amap returns nothing.
  const { response, resolvedTotal, manualConfirmTotal } =
    await resolveDirectionalSuggestions(sanitized, {
      startCoord: { lng: 121.48, lat: 31.23 },
      deps,
      cuisineHints: ["本帮菜"],
    });
  ok(resolvedTotal === 0, "screenshot/manual: resolvedTotal=0");
  ok(manualConfirmTotal === 1, `screenshot/manual: manualConfirmTotal=1 (got ${manualConfirmTotal})`);
  const dinner = response.plans[0].timeline.find((t) => t.activity_type === "dinner")!;
  ok(dinner.place_kind === "directional", "screenshot/manual: dinner stays directional");
  ok(dinner.place_name === "需要手动确认餐馆", `screenshot/manual: place_name (got ${dinner.place_name})`);
  ok(dinner.title === "晚餐：需要手动确认餐馆", `screenshot/manual: title (got ${dinner.title})`);
  ok(!dinner.amap_url, "screenshot/manual: no amap_url on stop");
  ok(dinner.lng == null && dinner.lat == null, "screenshot/manual: no coords on stop");
  ok(!/找一家.*小馆/.test(dinner.place_name), "screenshot/manual: no 找一家XX小馆");
  ok(!/找一家.*小馆/.test(dinner.title || ""), "screenshot/manual: no 找一家XX小馆 in title");
  ok(
    !/^#\S+(\s+#\S+)+$/.test(dinner.reason || ""),
    `screenshot/manual: reason not raw tags (got ${dinner.reason})`,
  );
  // Transport leg.
  const leg = response.plans[0].timeline.find((t) => t.activity_type === "transport")!;
  ok(leg.place_name === "需要手动确认餐馆", `screenshot/manual: transport place_name (got ${leg.place_name})`);
  ok(leg.title === "前往需要手动确认餐馆", `screenshot/manual: transport title (got ${leg.title})`);
  ok(!leg.amap_url, "screenshot/manual: transport no amap_url");
  ok(!leg.lng && !leg.lat, "screenshot/manual: transport coords cleared");
  ok(!/找一家.*小馆/.test(leg.place_name), "screenshot/manual: transport no 找一家XX小馆");
  ok(!/方向建议/.test(leg.place_name), "screenshot/manual: transport no 方向建议");
  // route_chain renamed to follow.
  for (const hop of response.plans[0].route_chain) {
    ok(!/找一家.*小馆/.test(hop.from), `screenshot/manual: route_chain.from clean (${hop.from})`);
    ok(!/找一家.*小馆/.test(hop.to), `screenshot/manual: route_chain.to clean (${hop.to})`);
    ok(!/方向建议/.test(hop.from), `screenshot/manual: route_chain.from no 方向建议 (${hop.from})`);
    ok(!/方向建议/.test(hop.to), `screenshot/manual: route_chain.to no 方向建议 (${hop.to})`);
  }
  // dataSources should NOT pretend amap was used.
  ok(response.dataSources.candidatesUsed !== true, "screenshot/manual: candidatesUsed not flipped");
}

console.log("\nALL DIRECTIONAL-RESOLVER SMOKE ASSERTIONS PASSED");

}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
