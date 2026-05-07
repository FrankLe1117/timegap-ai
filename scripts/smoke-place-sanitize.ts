/**
 * Smoke test for the synthetic-place sanitizer.
 *
 * Why this exists: a previous bug shipped where the demo planner emitted a
 * "晚餐：徐家汇本帮小馆" stop with a "在高德打开" link, even though the demo
 * dataset has no real coordinates for that node. This test:
 *   1. Asserts `isSyntheticConcretePlaceName` flags the canonical bad-name
 *      shapes and lets through real demo nodes (外滩, 武康路, 上海博物馆).
 *   2. Runs the full demo planner end-to-end with a normal Shanghai gap and
 *      asserts no plan timeline contains a clickable concrete-style synthetic
 *      restaurant or cafe (徐家汇本帮小馆, 武康路精品咖啡馆, 等).
 *   3. Verifies that any rewritten stop is marked `place_kind: "directional"`
 *      with no coords / no amap_url, so the UI cannot render a map link.
 *
 * Run via `npm run smoke` (wired through scripts/run-smoke-place-sanitize.cjs).
 */
import {
  isSyntheticConcretePlaceName,
  sanitizePlanResponse,
  sanitizeTimelineItem,
} from "../src/lib/place-sanitize";
import { planTimeGapTrip } from "../src/lib/planner";
import type { Plan, PlanResponse, TimelineItem } from "../src/types";

function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("PASS:", msg);
}

// ----- 1. Pattern detector ------------------------------------------------
const SYNTHETIC_NAMES = [
  "徐家汇本帮小馆",
  "徐家汇本帮菜小馆",
  "新天地本帮菜餐厅",
  "南京路老字号餐厅",
  "武康路法式小酒馆",
  "陆家嘴商务简餐",
  "虹桥火车站快餐区",
  "静安寺周边日料",
  "城隍庙小吃",
  "武康路精品咖啡馆",
  "新天地咖啡书吧",
  "人民广场茶馆",
  "静安寺咖啡休息点",
  "虹桥天地咖啡休息点",
  "虹桥天地晚餐",
  "人民广场小吃与本帮简餐",
];

for (const n of SYNTHETIC_NAMES) {
  ok(isSyntheticConcretePlaceName(n), `flags synthetic name: ${n}`);
}

const NON_SYNTHETIC = [
  "外滩",
  "武康路",
  "新天地",
  "上海博物馆",
  "南京路步行街",
  "豫园",
  "虹桥火车站",
  "上海柏悦酒店", // real candidate name shape
  "外婆家(虹桥店)",
];
for (const n of NON_SYNTHETIC) {
  ok(!isSyntheticConcretePlaceName(n), `does NOT flag real name: ${n}`);
}

// ----- 2. sanitizeTimelineItem unit ---------------------------------------
const demoDinner: TimelineItem = {
  start_time: "18:00",
  end_time: "19:00",
  title: "晚餐：徐家汇本帮小馆",
  place_name: "徐家汇本帮小馆",
  place_id: "food_xuhui_local",
  activity_type: "dinner",
  reason: "#local_food",
  estimated_travel_time_to_next_min: null,
  source: "demo",
};
const cleaned = sanitizeTimelineItem(demoDinner, "徐汇区");
ok(cleaned.place_name !== "徐家汇本帮小馆", "demo dinner place_name was rewritten");
ok(cleaned.place_kind === "directional", "demo dinner marked directional");
ok(!cleaned.amap_url, "demo dinner has no amap_url");
ok(cleaned.lng == null && cleaned.lat == null, "demo dinner has no coordinates");
ok(cleaned.title.startsWith("晚餐："), "demo dinner title still labelled as dinner");
ok(/徐汇区/.test(cleaned.place_name), "directional place_name keeps the area");

// Real-candidate stop must NOT be touched.
const realCandidate: TimelineItem = {
  ...demoDinner,
  title: "晚餐：上海柏悦酒店",
  place_name: "上海柏悦酒店",
  place_id: "amap:B0FFGPX001",
  source: "amap",
  candidate_reliability: "confirmed",
  lng: 121.5,
  lat: 31.23,
  amap_url: "https://uri.amap.com/marker?position=121.5%2C31.23&name=...",
};
const realPassthrough = sanitizeTimelineItem(realCandidate, "浦东新区");
ok(realPassthrough === realCandidate, "real candidate passes through untouched");

// Transport leg passes through.
const transport: TimelineItem = {
  start_time: "17:30",
  end_time: "18:00",
  title: "前往徐家汇本帮小馆",
  place_name: "徐家汇本帮小馆",
  activity_type: "transport",
  reason: "驾车/打车，预计30分钟",
  estimated_travel_time_to_next_min: null,
  travel_mode: "驾车/打车",
};
const transportSan = sanitizeTimelineItem(transport, "徐汇区");
ok(transportSan === transport, "transport leg untouched by per-item sanitizer");

// ----- 3. End-to-end planner output ---------------------------------------
const demoPlan = planTimeGapTrip(
  {
    city: "上海",
    start_location: "陆家嘴",
    start_time: "11:00",
    final_destination: "虹桥火车站",
    departure_time: "20:00",
    preferences: ["local_food", "city_walk"],
    constraints: [],
    budget_per_person: null,
    luggage: false,
    weather: "unknown",
    walking_preference: "medium",
    food_preference: ["本帮菜"],
    plan_style: "balanced",
  },
  {},
  undefined,
  { userText: "下午想吃本帮菜" },
);

function collectStops(p: Plan): TimelineItem[] {
  return p.timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
}

const allStops: TimelineItem[] = demoPlan.plans.flatMap(collectStops);
ok(allStops.length > 0, "demo planner produced at least one stop");
for (const s of allStops) {
  ok(
    !SYNTHETIC_NAMES.some((bad) => s.place_name === bad),
    `no stop carries a synthetic concrete name (place_name=${s.place_name})`,
  );
  if (isSyntheticConcretePlaceName(s.place_name)) {
    ok(false, `stop place_name still matches synthetic pattern: ${s.place_name}`);
  }
}

// Any commercial stop (lunch/dinner/coffee) coming purely from demo data must
// be marked directional with no map-link plumbing.
const demoCommercial = demoPlan.plans
  .flatMap((p) => p.timeline)
  .filter(
    (t) =>
      (t.activity_type === "lunch" ||
        t.activity_type === "dinner" ||
        t.activity_type === "coffee") &&
      (!t.source || t.source === "demo"),
  );
for (const s of demoCommercial) {
  ok(s.place_kind === "directional", `demo commercial stop is directional (${s.title})`);
  ok(!s.amap_url, `demo commercial stop has no amap_url (${s.title})`);
  ok(s.lng == null && s.lat == null, `demo commercial stop has no coords (${s.title})`);
}

// ----- 4. Idempotence + injection guard -----------------------------------
const reSan = sanitizePlanResponse(demoPlan);
const allStops2 = reSan.plans.flatMap(collectStops);
ok(
  allStops2.length === allStops.length,
  "second-pass sanitization preserves stop count (idempotent)",
);

// Even if something somehow injected a synthetic concrete stop into a plan,
// sanitizePlanResponse must wipe it.
const poisoned: PlanResponse = {
  ...demoPlan,
  plans: demoPlan.plans.map((p) => ({
    ...p,
    timeline: [
      ...p.timeline,
      {
        start_time: "19:30",
        end_time: "20:30",
        title: "晚餐：徐家汇本帮菜小馆",
        place_name: "徐家汇本帮菜小馆",
        place_id: "fake",
        activity_type: "dinner",
        reason: "leaked",
        estimated_travel_time_to_next_min: null,
        lng: 121.435,
        lat: 31.195,
        amap_url: "https://uri.amap.com/marker?position=121.435%2C31.195&name=...",
        source: "demo",
      } as TimelineItem,
    ],
  })),
};
const cleanedPoisoned = sanitizePlanResponse(poisoned);
const leakedStop = cleanedPoisoned.plans
  .flatMap((p) => p.timeline)
  .find((t) => t.title.startsWith("晚餐：") && /徐家汇/.test(t.title));
if (leakedStop) {
  ok(leakedStop.place_kind === "directional", "injected synthetic stop converted to directional");
  ok(!leakedStop.amap_url, "injected synthetic stop has no amap_url after guard");
  ok(leakedStop.place_name !== "徐家汇本帮菜小馆", "injected synthetic place_name rewritten");
}

console.log("\nALL PLACE-SANITIZE SMOKE ASSERTIONS PASSED");
