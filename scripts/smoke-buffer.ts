/**
 * Smoke regression test for terminal-aware buffer logic.
 *
 * Locks in:
 *   - high-speed rail / train default = 45min, "提前到站" → 60min
 *   - domestic flight default = 120min, with luggage/rain/rush addons
 *   - international flight default = 180min
 *   - generic destination fallback = 45min
 *   - calculateTimeBudget propagates terminal_kind / buffer_reason
 *
 * Run: node scripts/run-smoke-buffer.cjs
 */
import { detectTerminalKind, decideTerminalBuffer } from "../src/lib/terminal-buffer";
import { calculateTimeBudget } from "../src/lib/planner";
import type { Constraints } from "../src/types";

let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeConstraints(overrides: Partial<Constraints>): Constraints {
  return {
    city: "Shanghai",
    start_location: "陆家嘴",
    start_time: "13:00",
    final_destination: "上海虹桥站",
    departure_time: "21:00",
    preferences: [],
    constraints: [],
    budget_per_person: null,
    luggage: false,
    weather: "unknown",
    walking_preference: "medium",
    food_preference: [],
    plan_style: "balanced",
    ...overrides,
  };
}

// 1) Terminal kind detection ------------------------------------------------
eq(detectTerminalKind("上海虹桥站", "晚上9点虹桥站高铁"), "high_speed_rail", "虹桥站 + 高铁 → high_speed_rail");
eq(detectTerminalKind("上海站", "晚上9点上海站火车"), "train", "上海站 + 火车 → train (no HSR keyword)");
eq(detectTerminalKind("浦东机场", "晚上9点浦东机场飞机"), "domestic_flight", "浦东机场 + 飞机 → domestic_flight");
eq(detectTerminalKind("浦东机场", "晚上9点浦东机场国际航班"), "international_flight", "国际航班 → international_flight");
eq(detectTerminalKind("虹桥机场", "T2 国际航班"), "international_flight", "虹桥机场 + 国际 → international_flight");
eq(detectTerminalKind("陆家嘴", "下午4点陆家嘴喝咖啡"), "generic", "no terminal markers → generic");
eq(detectTerminalKind("虹桥火车站", "我坐G123高铁"), "high_speed_rail", "G车次 → high_speed_rail");

// 2) Buffer minutes ---------------------------------------------------------
const trainBase = decideTerminalBuffer(
  makeConstraints({ final_destination: "上海虹桥站" }),
  { userText: "晚上9点虹桥站高铁", arrivalMin: 21 * 60 },
);
eq(trainBase.terminal_kind, "high_speed_rail", "train base: kind = high_speed_rail");
eq(trainBase.buffer_min, 45, "train default = 45min");

const trainSafe = decideTerminalBuffer(
  makeConstraints({ final_destination: "上海虹桥站", constraints: ["safe_buffer"] }),
  { userText: "晚上9点虹桥站高铁，提前到站更稳妥", arrivalMin: 21 * 60 },
);
eq(trainSafe.buffer_min, 60, "train + 提前到站/safe_buffer = 60min");

const trainLuggageRain = decideTerminalBuffer(
  makeConstraints({ final_destination: "上海虹桥站", luggage: true, weather: "rainy" }),
  { userText: "晚上9点虹桥站高铁", arrivalMin: 21 * 60 },
);
ok(
  trainLuggageRain.buffer_min >= 45 + 10 + 10,
  `train + 行李 + 雨天 ≥ 65min — got ${trainLuggageRain.buffer_min}`,
);

const flightBase = decideTerminalBuffer(
  makeConstraints({ final_destination: "上海浦东机场" }),
  { userText: "晚上9点浦东机场飞机", arrivalMin: 21 * 60 },
);
eq(flightBase.terminal_kind, "domestic_flight", "flight base: kind = domestic_flight");
eq(flightBase.buffer_min, 120, "domestic flight default = 120min");

const flightLoaded = decideTerminalBuffer(
  makeConstraints({ final_destination: "上海浦东机场", luggage: true, weather: "rainy" }),
  { userText: "晚上9点浦东机场飞机", arrivalMin: 18 * 60 + 30 }, // 18:30 = rush
);
ok(
  flightLoaded.buffer_min >= 120 + 20 + 15 + 15,
  `domestic flight + 行李 + 雨 + 晚高峰 ≥ 170min — got ${flightLoaded.buffer_min}`,
);

const intl = decideTerminalBuffer(
  makeConstraints({ final_destination: "上海浦东机场" }),
  { userText: "晚上9点浦东机场国际航班", arrivalMin: 21 * 60 },
);
eq(intl.terminal_kind, "international_flight", "国际航班 → international_flight");
eq(intl.buffer_min, 180, "international flight default = 180min");

const generic = decideTerminalBuffer(
  makeConstraints({ final_destination: "陆家嘴" }),
  { userText: "下午4点陆家嘴", arrivalMin: 16 * 60 },
);
eq(generic.terminal_kind, "generic", "no terminal markers → generic kind");
eq(generic.buffer_min, 45, "generic fallback = 45min");

// 3) calculateTimeBudget integration ---------------------------------------
const tbHsr = calculateTimeBudget(
  makeConstraints({ start_time: "13:00", departure_time: "21:00", final_destination: "上海虹桥站" }),
  { userText: "晚上9点虹桥站高铁" },
);
eq(tbHsr.terminal_kind, "high_speed_rail", "TimeBudget: HSR kind");
eq(tbHsr.station_buffer_min, 45, "TimeBudget: HSR buffer = 45");
ok(typeof tbHsr.buffer_reason === "string" && tbHsr.buffer_reason!.includes("高铁"),
   `TimeBudget: HSR reason mentions 高铁 — got ${tbHsr.buffer_reason}`);

const tbFlight = calculateTimeBudget(
  makeConstraints({ start_time: "13:00", departure_time: "21:00", final_destination: "浦东机场" }),
  { userText: "晚上9点浦东机场飞机" },
);
eq(tbFlight.terminal_kind, "domestic_flight", "TimeBudget: domestic_flight kind");
ok(tbFlight.station_buffer_min >= 120, `TimeBudget: domestic flight ≥ 120 — got ${tbFlight.station_buffer_min}`);

const tbIntl = calculateTimeBudget(
  makeConstraints({ start_time: "13:00", departure_time: "21:00", final_destination: "浦东机场" }),
  { userText: "晚上9点浦东机场国际航班" },
);
eq(tbIntl.terminal_kind, "international_flight", "TimeBudget: international kind");
ok(tbIntl.station_buffer_min >= 180, `TimeBudget: intl ≥ 180 — got ${tbIntl.station_buffer_min}`);

// Buffer must actually shorten the activity window
ok(
  tbIntl.safe_activity_time_min < tbHsr.safe_activity_time_min,
  `intl flight buffer reduces safe_activity_time vs HSR — intl=${tbIntl.safe_activity_time_min}, hsr=${tbHsr.safe_activity_time_min}`,
);
ok(
  tbIntl.latest_leave_for_station < tbHsr.latest_leave_for_station,
  `intl flight buffer pulls latest_leave earlier — intl=${tbIntl.latest_leave_for_station}, hsr=${tbHsr.latest_leave_for_station}`,
);

if (failed === 0) {
  console.log("\nALL BUFFER SMOKE ASSERTIONS PASSED");
} else {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
