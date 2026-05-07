/**
 * Smoke regression test for multi-plan diversification.
 *
 * Why this exists: a previous bug shipped where the three generated plan
 * cards (均衡 / 稳妥 / 深度本地) all displayed the same set of stops because
 * `applyCandidatesToPlans` ran each plan independently and always picked the
 * single highest-scoring candidate from the same pool. The user saw three
 * cards with different titles/descriptions but identical content.
 *
 * This test fakes a PlanResponse with 3 plans + a candidate pool that has
 * multiple reliable alternatives per category, runs the real replacement
 * pipeline, and asserts:
 *   - Each plan picks a DIFFERENT non-terminal POI when alternatives exist.
 *   - Restaurants are not all the same across the 3 plans.
 *   - Strategy-aware score adjustments make the score bars distinct.
 *   - When the pool is constrained to one candidate per category, the
 *     fallback is honest: same POI is allowed but no fake duplicates appear.
 */
import { applyCandidatesToPlans } from "../src/lib/planner-replace";
import type { CandidatePool, Candidate } from "../src/lib/candidate-pool";
import type { PlanResponse, Plan, TimelineItem } from "../src/types";

function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("PASS:", msg);
}

function makeRestaurant(suffix: string, lng: number, lat: number, score: number): Candidate {
  return {
    id: `amap:R${suffix}`,
    name: `本帮餐厅${suffix}`,
    category: "restaurant",
    coord: { lng, lat },
    score,
    source: "amap",
    district: "测试区",
    address: `测试路${suffix}号`,
    tags: ["本帮菜"],
    poi_id: `R${suffix}`,
    raw_type: "餐饮服务;中餐厅;本帮江浙菜",
    reliability: "confirmed",
    confidence: 0.9,
    allow_in_itinerary: true,
  };
}

function makeStationFriendly(suffix: string, lng: number, lat: number, score: number): Candidate {
  return {
    id: `amap:S${suffix}`,
    name: `车站附近本帮店${suffix}`,
    category: "station_friendly",
    coord: { lng, lat },
    score,
    source: "amap",
    district: "测试区",
    address: `车站路${suffix}号`,
    tags: ["本帮菜"],
    poi_id: `S${suffix}`,
    raw_type: "餐饮服务;中餐厅",
    reliability: "confirmed",
    confidence: 0.9,
    allow_in_itinerary: true,
  };
}

function buildDemoPlan(planType: Plan["plan_type"]): Plan {
  const transportToLunch: TimelineItem = {
    start_time: "11:30",
    end_time: "12:00",
    title: "前往演示午餐",
    place_name: "演示午餐",
    activity_type: "transport",
    reason: "测试",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const lunchStop: TimelineItem = {
    start_time: "12:00",
    end_time: "13:00",
    title: "演示午餐",
    place_name: "演示午餐",
    place_id: "demo-lunch",
    activity_type: "lunch",
    reason: "demo",
    estimated_travel_time_to_next_min: 25,
    travel_mode: "驾车/打车",
    source: "demo",
  };
  const transportToDinner: TimelineItem = {
    start_time: "17:00",
    end_time: "17:30",
    title: "前往演示晚餐",
    place_name: "演示晚餐",
    activity_type: "transport",
    reason: "测试",
    estimated_travel_time_to_next_min: null,
    travel_mode: "驾车/打车",
  };
  const dinnerStop: TimelineItem = {
    start_time: "17:30",
    end_time: "18:30",
    title: "演示晚餐",
    place_name: "演示晚餐",
    place_id: "demo-dinner",
    activity_type: "dinner",
    reason: "demo",
    estimated_travel_time_to_next_min: 30,
    travel_mode: "驾车/打车",
    source: "demo",
  };
  const transportToDest: TimelineItem = {
    start_time: "18:30",
    end_time: "19:00",
    title: "前往车站",
    place_name: "测试车站",
    activity_type: "transport",
    reason: "测试",
    estimated_travel_time_to_next_min: 30,
    travel_mode: "驾车/打车",
  };
  const stationBuffer: TimelineItem = {
    start_time: "19:00",
    end_time: "19:30",
    title: "到站候车",
    place_name: "测试车站",
    activity_type: "station_buffer",
    reason: "缓冲",
    estimated_travel_time_to_next_min: null,
  };
  return {
    plan_name: planType,
    plan_type: planType,
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
      lunchStop,
      transportToDinner,
      dinnerStop,
      transportToDest,
      stationBuffer,
    ],
    route_chain: [],
    latest_leave_for_station: "19:00",
    risk_note: "",
    backup_suggestion: "",
    explanation: "",
  };
}

function buildResponse(plans: Plan[]): PlanResponse {
  return {
    parsedConstraints: {
      city: "上海",
      start_location: "陆家嘴",
      start_time: "11:00",
      final_destination: "测试车站",
      departure_time: "20:00",
      preferences: [],
      constraints: [],
      budget_per_person: null,
      luggage: false,
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
    plans,
    dataSources: {
      places: "demo",
      travelTimes: "demo",
      apiReady: "demo",
      routesSource: "demo",
      amapConfigured: true,
    },
  };
}

(async () => {
  // ==========================================================================
  // Case 1: Large pool — all 3 plans should pick DIFFERENT non-terminal POIs.
  // ==========================================================================
  const restaurants: Candidate[] = [
    makeRestaurant("A", 121.5, 31.24, 0.95),
    makeRestaurant("B", 121.51, 31.245, 0.92),
    makeRestaurant("C", 121.49, 31.235, 0.9),
    makeRestaurant("D", 121.48, 31.232, 0.88),
    makeRestaurant("E", 121.47, 31.228, 0.86),
  ];
  const stationFriendly: Candidate[] = [
    makeStationFriendly("X", 121.32, 31.197, 0.93),
    makeStationFriendly("Y", 121.325, 31.2, 0.9),
    makeStationFriendly("Z", 121.33, 31.205, 0.87),
  ];
  const richPool: CandidatePool = {
    byCategory: {
      restaurant: restaurants,
      cafe: [],
      scenic: [],
      indoor: [],
      station_friendly: stationFriendly,
    },
    hasRealData: true,
    sources: ["amap"],
  };

  const planTypes: Plan["plan_type"][] = ["balanced", "low_risk", "local_experience"];
  const richResp = buildResponse(planTypes.map(buildDemoPlan));
  const richResult = await applyCandidatesToPlans(richResp, richPool, {
    startCoord: { lng: 121.5, lat: 31.24 },
    destCoord: { lng: 121.32, lat: 31.197 },
  });

  ok(richResult.replacedTotal >= 3, "rich pool: replaced at least one stop in each plan");

  const lunchByPlan = richResult.response.plans.map((p) =>
    p.timeline.find((t) => t.activity_type === "lunch")?.place_name,
  );
  const dinnerByPlan = richResult.response.plans.map((p) =>
    p.timeline.find((t) => t.activity_type === "dinner")?.place_name,
  );

  console.log("lunchByPlan:", lunchByPlan);
  console.log("dinnerByPlan:", dinnerByPlan);

  const distinctLunches = new Set(lunchByPlan).size;
  ok(
    distinctLunches >= 2,
    `rich pool: at least 2 of 3 lunches differ (got ${distinctLunches} distinct out of 3)`,
  );

  // Non-terminal POIs (lunch is the non-terminal slot here) must not be
  // identical across all 3 plans when alternatives exist.
  ok(
    new Set(lunchByPlan).size === 3,
    `rich pool: all 3 lunch picks are distinct (got: ${lunchByPlan.join(" | ")})`,
  );

  // Strategy-aware scores should differ.
  const safetyScores = richResult.response.plans.map(
    (p) => p.suitability_tags.station_arrival_confidence,
  );
  const expScores = richResult.response.plans.map(
    (p) => p.suitability_tags.experience_score,
  );
  console.log("safetyScores:", safetyScores);
  console.log("expScores:", expScores);
  ok(
    new Set(safetyScores).size >= 2,
    `rich pool: safety scores differ across plans (got: ${safetyScores.join(",")})`,
  );
  ok(
    new Set(expScores).size >= 2,
    `rich pool: experience scores differ across plans (got: ${expScores.join(",")})`,
  );
  // The low_risk plan should have the highest safety, lowest experience.
  const idxOf = (t: Plan["plan_type"]) =>
    planTypes.indexOf(t);
  ok(
    safetyScores[idxOf("low_risk")] >= safetyScores[idxOf("local_experience")],
    "rich pool: low_risk safety >= local_experience safety",
  );
  ok(
    expScores[idxOf("local_experience")] >= expScores[idxOf("low_risk")],
    "rich pool: local_experience exp >= low_risk exp",
  );

  // ==========================================================================
  // Case 2: Constrained pool — only one candidate per category. Fallback must
  // be honest (same POI may repeat) but no fake duplicates / synthetic names.
  // ==========================================================================
  const tinyPool: CandidatePool = {
    byCategory: {
      restaurant: [restaurants[0]],
      cafe: [],
      scenic: [],
      indoor: [],
      station_friendly: [stationFriendly[0]],
    },
    hasRealData: true,
    sources: ["amap"],
  };
  const tinyResp = buildResponse(planTypes.map(buildDemoPlan));
  const tinyResult = await applyCandidatesToPlans(tinyResp, tinyPool, {
    startCoord: { lng: 121.5, lat: 31.24 },
    destCoord: { lng: 121.32, lat: 31.197 },
  });

  // Even with 1 candidate, the same one is allowed to land in multiple plans
  // (no fake names, no synthetic duplicates).
  const allLunchNames = tinyResult.response.plans.map(
    (p) => p.timeline.find((t) => t.activity_type === "lunch")?.place_name || "",
  );
  console.log("tiny pool lunchByPlan:", allLunchNames);
  ok(
    allLunchNames.every((n) => n.startsWith("本帮餐厅") || n === "演示午餐"),
    "tiny pool: every lunch is either the real candidate or the demo placeholder (no fake names)",
  );
  // Strategy-aware scores still differ even when content is shared.
  const tinySafety = tinyResult.response.plans.map(
    (p) => p.suitability_tags.station_arrival_confidence,
  );
  const tinyExp = tinyResult.response.plans.map(
    (p) => p.suitability_tags.experience_score,
  );
  ok(
    new Set(tinySafety).size >= 2 || new Set(tinyExp).size >= 2,
    `tiny pool: at least one of safety/exp scores differs across plans (safety=${tinySafety.join(",")}, exp=${tinyExp.join(",")})`,
  );

  console.log("\nALL MULTI-PLAN DIVERSITY ASSERTIONS PASSED");
})().catch((err) => {
  console.error("Smoke threw:", err);
  process.exit(1);
});
