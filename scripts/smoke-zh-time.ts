/**
 * Smoke regression test for Chinese natural-language time parsing.
 *
 * Why this exists: shipped bug where "下午1点从静安寺出发，晚上9点虹桥站出发"
 * parsed as 01:30 → 21:30 (≈20h window). The fix has two parts: (1) a
 * deterministic Chinese time parser in src/lib/zh-time.ts, and (2) reconciling
 * the LLM's HH:MM with the original text so a missing-meridiem hallucination
 * is corrected. This smoke locks down both.
 *
 * Run: node scripts/run-smoke-zh-time.cjs
 */
import { parseChineseTime, parseChineseTimeAll, reconcileTimeWithText } from "../src/lib/zh-time";
import { parseConstraintsRule } from "../src/lib/constraint-parser";
import { calculateTimeBudget } from "../src/lib/planner";

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

// 1) Single-token parses ----------------------------------------------------
eq(parseChineseTime("下午1点"), "13:00", "下午1点 → 13:00");
eq(parseChineseTime("下午一点"), "13:00", "下午一点 → 13:00");
eq(parseChineseTime("晚上9点"), "21:00", "晚上9点 → 21:00");
eq(parseChineseTime("晚上九点"), "21:00", "晚上九点 → 21:00");
eq(parseChineseTime("上午9点"), "09:00", "上午9点 → 09:00");
eq(parseChineseTime("中午12点"), "12:00", "中午12点 → 12:00");
eq(parseChineseTime("中午十二点"), "12:00", "中午十二点 → 12:00");
eq(parseChineseTime("中午1点"), "13:00", "中午1点 → 13:00");
eq(parseChineseTime("凌晨1点"), "01:00", "凌晨1点 → 01:00");
eq(parseChineseTime("下午1点半"), "13:30", "下午1点半 → 13:30");
eq(parseChineseTime("下午一点半"), "13:30", "下午一点半 → 13:30");
eq(parseChineseTime("晚上九点半"), "21:30", "晚上九点半 → 21:30");
eq(parseChineseTime("21:30"), "21:30", "21:30 (digital) → 21:30");
eq(parseChineseTime("9:30"), "09:30", "9:30 → 09:30");
eq(parseChineseTime("9点30"), "09:30", "9点30 → 09:30");
eq(parseChineseTime("9点30分"), "09:30", "9点30分 → 09:30");
eq(parseChineseTime("九点三十"), "09:30", "九点三十 → 09:30");
eq(parseChineseTime("九点整"), "09:00", "九点整 → 09:00");
eq(parseChineseTime("傍晚6点"), "18:00", "傍晚6点 → 18:00");
eq(parseChineseTime("早上7点45分"), "07:45", "早上7点45分 → 07:45");

// 2) Multi-time sentences ---------------------------------------------------
const all = parseChineseTimeAll("下午1点从静安寺出发，晚上9点虹桥站出发");
ok(all.length === 2, `两次时间被识别 (got ${all.length})`);
eq(all[0]?.time, "13:00", "首段时间 = 13:00");
eq(all[1]?.time, "21:00", "末段时间 = 21:00");

// 3) Constraint-parser rule mode --------------------------------------------
const r = parseConstraintsRule(
  "今天是旅行最后一天，下午1点从静安寺出发，晚上9点虹桥站出发。今天下雨，找室内为主。",
);
eq(r.constraints.start_time, "13:00", "rule parser start_time = 13:00");
eq(r.constraints.departure_time, "21:00", "rule parser departure_time = 21:00");
eq(r.constraints.start_location, "静安寺", "rule parser start = 静安寺");
ok(r.constraints.final_destination.includes("虹桥"), "rule parser dest contains 虹桥");
eq(r.constraints.weather, "rainy", "rule parser weather = rainy");
ok(r.constraints.preferences.includes("indoor"), "rule parser prefers indoor");

// 4) Time budget for 13:00 → 21:00 ------------------------------------------
const tb = calculateTimeBudget(r.constraints);
eq(tb.free_window_min, 480, "free_window_min = 480 (8h) for 13→21");
ok(tb.safe_activity_time_min > 0 && tb.safe_activity_time_min < 480,
   `safe_activity_time_min in (0, 480) — got ${tb.safe_activity_time_min}`);
ok(!tb.planning_deadline.startsWith("01:"),
   `planning_deadline must not be early-morning, got ${tb.planning_deadline}`);

// 5) Same-day guard: if start>=depart (parser miss) we don't cross midnight
const guarded = calculateTimeBudget({
  ...r.constraints,
  start_time: "21:00",
  departure_time: "21:00",
});
eq(guarded.free_window_min, 60, "guard: 21:00→21:00 collapses to 60min, not 1440");

// 6) LLM reconciliation ------------------------------------------------------
// Simulate Perplexity returning the meridiem-stripped time; the original text
// has the meridiem prefix, so we should correct it.
eq(
  reconcileTimeWithText("01:00", "下午1点从静安寺出发，晚上9点虹桥站出发", "start"),
  "13:00",
  "reconcile: '01:00' + '下午1点' → '13:00'",
);
eq(
  reconcileTimeWithText("09:00", "下午1点从静安寺出发，晚上9点虹桥站出发", "end"),
  "21:00",
  "reconcile: '09:00' + '晚上9点' → '21:00'",
);
// When LLM time agrees with text, leave it alone.
eq(
  reconcileTimeWithText("13:00", "下午1点从静安寺出发", "start"),
  "13:00",
  "reconcile: agreement preserved",
);
// When user wrote a digital time, trust it directly.
eq(
  reconcileTimeWithText("", "21:30 出发", "end"),
  "21:30",
  "reconcile: empty LLM time + digital text → text-derived",
);

if (failed === 0) {
  console.log("\nALL ZH-TIME SMOKE ASSERTIONS PASSED");
} else {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
