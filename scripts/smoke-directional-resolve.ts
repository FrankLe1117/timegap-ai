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
  extractDirectionalIntent,
  isPoiReliableForActivity,
  resolveDirectionalSuggestions,
  type AmapSearchDeps,
} from "../src/lib/directional-resolver";
import type { AmapPoi } from "../src/lib/amap-client";
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

// 3b. Weak POI -> directional preserved.
{
  const resp = buildResponse(directionalDinner);
  const deps = makeDeps([weakPoiNoId, weakPoiSynthName]);
  const { response, resolvedTotal } = await resolveDirectionalSuggestions(resp, {
    startCoord: { lng: 121.49, lat: 31.23 },
    deps,
  });
  ok(resolvedTotal === 0, `resolvedTotal === 0 when only weak POIs returned (got ${resolvedTotal})`);
  const stops = response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  const s = stops[0];
  ok(s.place_kind === "directional", "stop remains directional");
  ok(!s.amap_url, "stop has no amap_url");
  ok(s.lng == null && s.lat == null, "stop has no coords");
  ok(/方向建议/.test(s.place_name), `place_name still directional (got ${s.place_name})`);
}

// 3c. Empty POI list -> directional preserved.
{
  const resp = buildResponse(directionalDinner);
  const deps = makeDeps([]);
  const { response, resolvedTotal } = await resolveDirectionalSuggestions(resp, {
    startCoord: { lng: 121.49, lat: 31.23 },
    deps,
  });
  ok(resolvedTotal === 0, "resolvedTotal === 0 with no POIs");
  const s = response.plans[0].timeline.find((t) => t.activity_type === "dinner")!;
  ok(s.place_kind === "directional", "stop stays directional with empty results");
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

console.log("\nALL DIRECTIONAL-RESOLVER SMOKE ASSERTIONS PASSED");

}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
