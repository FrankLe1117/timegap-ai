/**
 * Smoke regression test for multi-city free-form parsing.
 *
 * Locks in: a Guangzhou input ("广州出差，中午12点在珠江新城收尾，晚上10点白云
 * 机场起飞") never falls back to Shanghai defaults — city = Guangzhou, start =
 * 珠江新城, dest contains 白云机场, departure_time = 22:00, terminal_kind =
 * domestic_flight, no Shanghai-prefixed assumption strings.
 *
 * Run: node scripts/run-smoke-city.cjs
 */
import { parseConstraintsRule } from "../src/lib/constraint-parser";
import { calculateTimeBudget } from "../src/lib/planner";
import { detectCity, locateInCity, profileByKey } from "../src/lib/city-detect";

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

const guangzhou =
  "广州出差，中午12点在珠江新城收尾，晚上10点白云机场起飞。想体验更本地，但绝对不能误车。";

// 1) City detection ---------------------------------------------------------
const gz = detectCity(guangzhou);
eq(gz.key, "guangzhou", "detectCity('广州 ... 珠江新城 ... 白云机场') = guangzhou");
eq(gz.zh, "广州", "guangzhou profile zh = 广州");
eq(gz.en, "Guangzhou", "guangzhou profile en = Guangzhou");

const beijing = detectCity("下午2点在三里屯结束事情，晚上8点首都机场起飞");
eq(beijing.key, "beijing", "detectCity('三里屯 ... 首都机场') = beijing");

const chengdu = detectCity("成都最后一天，下午1点从春熙路出发，晚上9点成都东站发车");
eq(chengdu.key, "chengdu", "detectCity('成都 ... 春熙路 ... 成都东站') = chengdu");

const shanghaiDefault = detectCity("没头没脑的一段话");
eq(shanghaiDefault.key, "shanghai", "no signal → default shanghai");

// 2) locateInCity -----------------------------------------------------------
const gzLoc = locateInCity(gz, guangzhou);
eq(gzLoc.start, "珠江新城", "guangzhou: start = 珠江新城");
eq(gzLoc.end, "广州白云国际机场", "guangzhou: end = 广州白云国际机场");

// 3) Full rule parse for the Guangzhou input --------------------------------
const r = parseConstraintsRule(guangzhou);
eq(r.constraints.city, "Guangzhou", "rule parser city = Guangzhou (NOT Shanghai)");
eq(r.constraints.start_location, "珠江新城", "rule parser start = 珠江新城");
eq(
  r.constraints.final_destination,
  "广州白云国际机场",
  "rule parser final_destination = 广州白云国际机场",
);
eq(r.constraints.start_time, "12:00", "rule parser start_time = 12:00 (中午12点)");
eq(r.constraints.departure_time, "22:00", "rule parser departure_time = 22:00 (晚上10点)");

// Guangzhou input must never produce Shanghai-default assumption strings.
ok(
  !r.assumptions.some((a) => a.includes("陆家嘴")),
  `assumptions never mention 陆家嘴 — got ${JSON.stringify(r.assumptions)}`,
);
ok(
  !r.assumptions.some((a) => a.includes("上海虹桥站")),
  `assumptions never mention 上海虹桥站 — got ${JSON.stringify(r.assumptions)}`,
);
// All four core fields were extracted, so missing must be empty.
eq(r.missing.length, 0, "missing is empty for fully-specified Guangzhou input");

// "绝对不能误车" → avoid_rushing constraint propagated.
ok(
  r.constraints.constraints.includes("avoid_rushing"),
  `avoid_rushing constraint extracted from "绝对不能误车" — got ${JSON.stringify(r.constraints.constraints)}`,
);
// "更本地" → local_food preference.
ok(
  r.constraints.preferences.includes("local_food"),
  `local_food preference extracted from "更本地" — got ${JSON.stringify(r.constraints.preferences)}`,
);

// 4) Time budget — terminal must be recognised as flight, not train ---------
const tb = calculateTimeBudget(r.constraints, { userText: guangzhou });
eq(tb.terminal_kind, "domestic_flight", "TimeBudget: 白云机场 → domestic_flight");
ok(
  tb.station_buffer_min >= 120,
  `TimeBudget: domestic flight buffer ≥ 120 — got ${tb.station_buffer_min}`,
);
ok(
  typeof tb.buffer_reason === "string" && tb.buffer_reason!.includes("国内航班"),
  `TimeBudget: buffer_reason mentions 国内航班 — got ${tb.buffer_reason}`,
);
// 12:00 → 22:00 = 600 minutes free window.
eq(tb.free_window_min, 600, "free_window_min = 600 (10h) for 12:00→22:00");

// 5) Missing-info Guangzhou input falls back to Guangzhou anchors -----------
const partial = parseConstraintsRule("广州出差，下午起飞回去");
eq(partial.constraints.city, "Guangzhou", "partial guangzhou: city = Guangzhou");
eq(
  partial.constraints.start_location,
  "珠江新城",
  "partial guangzhou: default start = 珠江新城 (not 陆家嘴)",
);
eq(
  partial.constraints.final_destination,
  "广州白云国际机场",
  "partial guangzhou: default dest = 广州白云国际机场 (not 上海虹桥站)",
);
ok(
  partial.assumptions.some((a) => a.includes("珠江新城")),
  `partial guangzhou assumptions name 珠江新城 — got ${JSON.stringify(partial.assumptions)}`,
);
ok(
  !partial.assumptions.some((a) => a.includes("陆家嘴") || a.includes("上海虹桥")),
  `partial guangzhou assumptions never mention Shanghai anchors — got ${JSON.stringify(partial.assumptions)}`,
);

// 6) Beijing + Chengdu sanity ----------------------------------------------
const bj = parseConstraintsRule(
  "下午2点在三里屯结束事情，晚上8点首都机场起飞。带行李，不想走太多路。",
);
eq(bj.constraints.city, "Beijing", "beijing rule: city = Beijing");
eq(bj.constraints.start_location, "三里屯", "beijing rule: start = 三里屯");
eq(bj.constraints.final_destination, "首都国际机场", "beijing rule: dest = 首都国际机场");
eq(bj.constraints.luggage, true, "beijing rule: luggage true");

const cd = parseConstraintsRule(
  "成都最后一天，下午1点从春熙路出发，晚上9点成都东站发车。下雨，找室内为主。",
);
eq(cd.constraints.city, "Chengdu", "chengdu rule: city = Chengdu");
eq(cd.constraints.start_location, "春熙路", "chengdu rule: start = 春熙路");
eq(cd.constraints.final_destination, "成都东站", "chengdu rule: dest = 成都东站");
eq(cd.constraints.weather, "rainy", "chengdu rule: weather = rainy");

// 7) profileByKey round-trip ----------------------------------------------
eq(profileByKey("Guangzhou").key, "guangzhou", "profileByKey('Guangzhou') = guangzhou");
eq(profileByKey("广州").key, "guangzhou", "profileByKey('广州') = guangzhou");
eq(profileByKey(undefined).key, "shanghai", "profileByKey(undefined) → shanghai");

if (failed === 0) {
  console.log("\nALL CITY SMOKE ASSERTIONS PASSED");
} else {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
