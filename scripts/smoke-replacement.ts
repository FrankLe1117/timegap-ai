/**
 * Smoke regression test for candidate replacement identity.
 *
 * Why this exists: a previous bug shipped where the displayed name of a
 * replaced stop was the candidate's name, but the amap_url and coords still
 * pointed at the original demo place — so clicking "在高德打开" opened the
 * wrong place. This test fakes a tiny PlanResponse + CandidatePool, runs the
 * real replacement pipeline, and asserts every replaced TimelineItem has
 * internally consistent identity (name/coord/amap_url all from the same
 * candidate).
 *
 * Run: npx tsc -p scripts/smoke-tsconfig.json && node .smoke-build/scripts/smoke-replacement.js
 */
import { applyCandidatesToPlans } from "../src/lib/planner-replace";
import type { CandidatePool } from "../src/lib/candidate-pool";
import type { PlanResponse, Plan, TimelineItem } from "../src/types";

function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("PASS:", msg);
}

const candidate = {
  id: "amap:B0FFGPX001",
  name: "上海柏悦酒店",
  category: "restaurant" as const,
  coord: { lng: 121.503452, lat: 31.236739 },
  score: 0.91,
  source: "amap" as const,
  district: "浦东新区",
  address: "世纪大道100号",
  tags: ["五星级酒店"],
  poi_id: "B0FFGPX001",
  raw_type: "餐饮服务;中餐厅;本帮江浙菜",
  reliability: "confirmed" as const,
  confidence: 0.95,
  allow_in_itinerary: true,
};

const stationFriendlyCandidate = {
  id: "amap:B0FFGPX999",
  name: "外婆家(虹桥店)",
  category: "station_friendly" as const,
  coord: { lng: 121.32, lat: 31.197 },
  score: 0.9,
  source: "amap" as const,
  district: "闵行区",
  tags: ["本帮菜"],
  poi_id: "B0FFGPX999",
  raw_type: "餐饮服务;中餐厅;本帮江浙菜",
  reliability: "confirmed" as const,
  confidence: 0.95,
  allow_in_itinerary: true,
};

const pool: CandidatePool = {
  byCategory: {
    restaurant: [candidate],
    cafe: [],
    scenic: [],
    indoor: [],
    station_friendly: [stationFriendlyCandidate],
  },
  hasRealData: true,
  sources: ["amap"],
};

const demoStop: TimelineItem = {
  start_time: "12:00",
  end_time: "13:00",
  // Crucially, the OLD demo identity. After replacement, none of these should
  // leak into the final item.
  title: "在 老克勒餐厅 享用午餐",
  place_name: "老克勒餐厅",
  place_id: "demo-laokele",
  activity_type: "lunch",
  reason: "demo: 演示城市图",
  estimated_travel_time_to_next_min: 25,
  travel_mode: "驾车/打车",
  is_rush_hour: false,
  lng: 121.4737,
  lat: 31.2304,
  // The buggy enrich step would have set this to the demo coord URL. After
  // replacement it MUST be overwritten to the candidate's marker URL.
  amap_url:
    "https://uri.amap.com/marker?position=121.4737,31.2304&name=" +
    encodeURIComponent("老克勒餐厅") +
    "&src=TimeGap%20AI&coordinate=gaode&callnative=1",
  source: "demo",
};

const finalDinner: TimelineItem = {
  start_time: "17:30",
  end_time: "18:30",
  title: "在 苏浙汇 享用晚餐",
  place_name: "苏浙汇",
  place_id: "demo-suzhe",
  activity_type: "dinner",
  reason: "demo",
  estimated_travel_time_to_next_min: 20,
  travel_mode: "驾车/打车",
  is_rush_hour: false,
  source: "demo",
};

const transportToLunch: TimelineItem = {
  start_time: "11:30",
  end_time: "12:00",
  title: "前往老克勒餐厅",
  place_name: "老克勒餐厅",
  activity_type: "transport",
  reason: "驾车/打车，预计30分钟",
  estimated_travel_time_to_next_min: null,
  travel_mode: "驾车/打车",
};

const transportToDinner: TimelineItem = {
  start_time: "17:00",
  end_time: "17:30",
  title: "前往苏浙汇",
  place_name: "苏浙汇",
  activity_type: "transport",
  reason: "驾车/打车，预计30分钟",
  estimated_travel_time_to_next_min: null,
  travel_mode: "驾车/打车",
};

const transportToDest: TimelineItem = {
  start_time: "18:30",
  end_time: "19:00",
  title: "前往虹桥火车站",
  place_name: "虹桥火车站",
  activity_type: "transport",
  reason: "驾车/打车，预计30分钟",
  estimated_travel_time_to_next_min: 30,
  travel_mode: "驾车/打车",
};

const stationBuffer: TimelineItem = {
  start_time: "19:00",
  end_time: "19:30",
  title: "到站候车缓冲",
  place_name: "虹桥火车站",
  activity_type: "station_buffer",
  reason: "缓冲",
  estimated_travel_time_to_next_min: null,
};

const plan: Plan = {
  plan_name: "balanced-test",
  plan_type: "balanced",
  one_sentence_summary: "test",
  tradeoff_summary: "",
  suitability_tags: {
    time_safety: "High",
    rush_hour_exposure: "Low",
    walking_intensity: "Low",
    local_experience: "Medium",
    luggage_friendly: "High",
    weather_robustness: "High",
    station_arrival_confidence: 80,
    experience_score: 70,
  },
  timeline: [
    transportToLunch,
    demoStop,
    transportToDinner,
    finalDinner,
    transportToDest,
    stationBuffer,
  ],
  route_chain: [],
  latest_leave_for_station: "19:00",
  risk_note: "",
  backup_suggestion: "",
  explanation: "",
};

const planResponse: PlanResponse = {
  parsedConstraints: {
    city: "上海",
    start_location: "陆家嘴",
    start_time: "11:00",
    final_destination: "虹桥火车站",
    departure_time: "20:00",
    preferences: [],
    constraints: [],
    budget_per_person: null,
    luggage: true,
    weather: "unknown",
    walking_preference: "low",
    food_preference: [],
    plan_style: "balanced",
  },
  timeBudget: {
    free_window_min: 540,
    station_buffer_min: 30,
    planning_deadline: "20:00",
    estimated_final_transfer_min: 30,
    latest_leave_for_station: "19:00",
    safe_activity_time_min: 480,
    rush_hour_detected: false,
    rush_hour_note: "",
  },
  plans: [plan],
  dataSources: {
    places: "demo",
    travelTimes: "demo",
    apiReady: "demo",
    routesSource: "demo",
    amapConfigured: true,
  },
};

(async () => {
  const result = await applyCandidatesToPlans(planResponse, pool, {
    startCoord: { lng: 121.5, lat: 31.24 },
    destCoord: { lng: 121.32, lat: 31.197 },
  });

  ok(result.replacedTotal >= 1, "at least one stop was replaced");

  const replacedPlan = result.response.plans[0];
  const stops = replacedPlan.timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );

  // The original lunch stop should have been replaced with `candidate`.
  const lunch = stops.find((t) => t.activity_type === "lunch")!;
  ok(!!lunch, "lunch stop survives replacement");
  ok(lunch.place_name === candidate.name, `lunch place_name === '${candidate.name}'`);
  ok(lunch.title.includes(candidate.name), "lunch title includes candidate name");
  ok(!lunch.title.includes("老克勒"), "lunch title does NOT contain demo name 老克勒");
  ok(lunch.lng === candidate.coord.lng && lunch.lat === candidate.coord.lat, "lunch coords match candidate coords");
  ok(lunch.source === candidate.source, "lunch source === amap");
  ok(typeof lunch.candidate_score === "number", "candidate_score is numeric");
  ok(!!lunch.amap_url, "lunch.amap_url is set");
  // URLSearchParams encodes commas, so check the encoded form.
  const encodedLunchPos = `${candidate.coord.lng}%2C${candidate.coord.lat}`;
  ok(lunch.amap_url!.includes(encodedLunchPos), "amap_url contains candidate coordinates (encoded)");
  ok(
    lunch.amap_url!.includes(encodeURIComponent(candidate.name)),
    "amap_url contains candidate name",
  );
  ok(
    !lunch.amap_url!.includes(encodeURIComponent("老克勒餐厅")),
    "amap_url does NOT reference demo name",
  );

  const dinner = stops.find((t) => t.activity_type === "dinner")!;
  ok(!!dinner, "dinner stop survives");
  ok(
    dinner.place_name === stationFriendlyCandidate.name,
    `dinner place_name === '${stationFriendlyCandidate.name}'`,
  );
  ok(
    dinner.lng === stationFriendlyCandidate.coord.lng && dinner.lat === stationFriendlyCandidate.coord.lat,
    "dinner coords === station_friendly candidate coords",
  );
  const encodedDinnerPos = `${stationFriendlyCandidate.coord.lng}%2C${stationFriendlyCandidate.coord.lat}`;
  ok(!!dinner.amap_url && dinner.amap_url.includes(encodedDinnerPos), "dinner amap_url uses candidate coords (encoded)");

  // Transport legs should reference the upcoming stop's identity.
  const lunchLeg = replacedPlan.timeline.find(
    (t) => t.activity_type === "transport" && t.place_name === candidate.name,
  );
  ok(!!lunchLeg, "transport leg toward candidate uses candidate name");
  ok(
    lunchLeg!.lng === candidate.coord.lng && lunchLeg!.lat === candidate.coord.lat,
    "transport leg coords === candidate coords",
  );
  ok(!!lunchLeg!.amap_url, "transport leg has amap_url");
  ok(
    lunchLeg!.amap_url!.includes(encodedLunchPos) ||
      lunchLeg!.amap_url!.includes(`tocoord=${candidate.coord.lng}%2C${candidate.coord.lat}`),
    "transport leg amap_url references candidate coords",
  );

  // Station buffer should use destination coords/url, not stale lunch coords.
  const buffer = replacedPlan.timeline.find((t) => t.activity_type === "station_buffer");
  ok(!!buffer, "station_buffer present after replacement");
  ok(buffer!.lng === 121.32 && buffer!.lat === 31.197, "station_buffer coords === destCoord");
  ok(
    !!buffer!.amap_url && buffer!.amap_url.includes("121.32%2C31.197"),
    "station_buffer amap_url points at destination",
  );

  // ----- Reliability gate regression -----
  // A synthetic candidate (no poi_id, generic name, no address/type) must not
  // replace a demo dinner stop, even when nothing else fills the slot.
  const syntheticCandidate = {
    id: "amap:poi:徐家汇本帮小馆",
    name: "徐家汇本帮小馆",
    category: "restaurant" as const,
    coord: { lng: 121.435, lat: 31.195 },
    score: 0.5,
    source: "amap" as const,
    district: "徐汇区",
    poi_id: undefined,
    raw_type: undefined,
    reliability: "suggested" as const,
    confidence: 0.1,
    allow_in_itinerary: false,
  };

  const syntheticPool: CandidatePool = {
    byCategory: {
      restaurant: [syntheticCandidate],
      cafe: [],
      scenic: [],
      indoor: [],
      station_friendly: [syntheticCandidate],
    },
    hasRealData: true,
    sources: ["amap"],
  };

  // Build a fresh demo plan with the same shape as the original.
  const synDemoLunch: TimelineItem = { ...demoStop };
  const synDemoDinner: TimelineItem = { ...finalDinner };
  const synPlan: Plan = {
    ...plan,
    timeline: [
      transportToLunch,
      synDemoLunch,
      transportToDinner,
      synDemoDinner,
      transportToDest,
      stationBuffer,
    ],
  };
  const synResp: PlanResponse = { ...planResponse, plans: [synPlan] };
  const synResult = await applyCandidatesToPlans(synResp, syntheticPool, {
    startCoord: { lng: 121.5, lat: 31.24 },
    destCoord: { lng: 121.32, lat: 31.197 },
  });
  ok(synResult.replacedTotal === 0, "synthetic candidate did NOT replace any stop");
  const synStops = synResult.response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  const synLunch = synStops.find((t) => t.activity_type === "lunch")!;
  const synDinner = synStops.find((t) => t.activity_type === "dinner")!;
  ok(synLunch.place_name === "老克勒餐厅", "demo lunch place_name preserved");
  ok(synDinner.place_name === "苏浙汇", "demo dinner place_name preserved");
  ok(
    !synStops.some((t) => t.place_name === "徐家汇本帮小馆"),
    "synthetic name 徐家汇本帮小馆 never appears in timeline",
  );
  ok(
    !synStops.some((t) => t.candidate_reliability === "suggested"),
    "no stop is tagged with reliability=suggested",
  );
  ok(
    synResult.response.dataSources.candidatesUsed !== true,
    "candidatesUsed is not set when only synthetic candidates exist",
  );

  // ----- Reliability propagation -----
  // The confirmed candidate from the original test should now carry through
  // candidate_reliability === "confirmed" on the replaced lunch stop.
  ok(
    lunch.candidate_reliability === "confirmed",
    "confirmed candidate propagates candidate_reliability=confirmed",
  );

  console.log("\nALL SMOKE ASSERTIONS PASSED");
})().catch((err) => {
  console.error("Smoke threw:", err);
  process.exit(1);
});
