import { Constraints, ParseResult } from "@/types";
import { parseChineseTimeAll } from "./zh-time";
import { detectCity, locateInCity, CityProfile } from "./city-detect";

/**
 * Pick start and end times from the user's free-form Chinese input.
 *
 * Strategy:
 *   1. Find every time mention with its character offset.
 *   2. For each mention, classify it as start-leaning or end-leaning by
 *      looking at the surrounding clause for departure/leave keywords.
 *   3. If we still can't tell, fall back to "first = start, last = end".
 */
function extractStartEndTimes(text: string): { start: string | null; end: string | null } {
  const hits = parseChineseTimeAll(text);
  if (hits.length === 0) return { start: null, end: null };
  if (hits.length === 1) return { start: hits[0].time, end: null };

  // Look at the clause around each hit to classify intent.
  const clauseFor = (i: number): string => {
    const left = text.slice(0, i).split(/[，。；,;\n]/).pop() || "";
    const right = text.slice(i).split(/[，。；,;\n]/)[0] || "";
    return left + right;
  };

  const startKeyword = /出发|开始|结束|开完|完成|办完|空(下来|出来)?|有空|空档|落地|到达|抵达|开会|收尾/;
  const endKeyword = /出发|离开|坐.{0,4}(车|高铁|火车|飞机|动车|地铁)|高铁|火车|飞机|动车|起飞|赶车|车次|航班|返程|登机|检票/;

  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < hits.length; i++) {
    const c = clauseFor(hits[i].index);
    const isEnd = endKeyword.test(c) && /(出发|离开|高铁|火车|飞机|动车|起飞|赶车|车次|航班|返程|登机|检票)/.test(c);
    const isStart = startKeyword.test(c) && !isEnd;
    if (isStart && startIdx === -1) startIdx = i;
    if (isEnd) endIdx = i;
  }

  // Fallbacks: first/last in document order.
  if (startIdx === -1) startIdx = 0;
  if (endIdx === -1 || endIdx === startIdx) endIdx = hits.length - 1;
  if (endIdx === startIdx) return { start: hits[startIdx].time, end: null };

  return { start: hits[startIdx].time, end: hits[endIdx].time };
}

function extractPreferences(text: string): string[] {
  const prefs: string[] = [];
  if (text.match(/不太累|轻松|relax|不累/)) prefs.push("relaxed");
  if (text.match(/本地|本帮|特色|地道|local/)) prefs.push("local_food");
  if (text.match(/不?太?贵|便宜|预算|budget|实惠|性价比/)) prefs.push("not_expensive");
  if (text.match(/逛|city.?walk|漫步|散步|走走/)) prefs.push("city_walk");
  if (text.match(/咖啡|coffee|喝杯/)) prefs.push("coffee");
  if (text.match(/室内|下雨|rain|避雨/)) prefs.push("indoor");
  if (text.match(/拍照|photo|打卡/)) prefs.push("photo");
  if (text.match(/安静|quiet|人少/)) prefs.push("quiet");
  if (text.match(/不?想?游客|避开|本地人/)) prefs.push("avoid_tourist");
  return prefs;
}

function extractConstraints(text: string): string[] {
  const cons: string[] = [];
  if (text.match(/不?赶|安全|准时|不能误|别误|绝对不能误/)) cons.push("avoid_rushing");
  if (text.match(/buffer|提前|早点到|预留|安全余量|宁早不晚/)) cons.push("safe_buffer");
  if (text.match(/行李|行李箱|luggage|箱子/)) cons.push("luggage_friendly");
  if (text.match(/下雨|雨天|rain/)) cons.push("rain_friendly");
  if (text.match(/少走|low.?walk|不想走|别走太多/)) cons.push("low_walking");
  return cons;
}

/**
 * City-aware fallback assumption text for the clarification card.
 * Uses the actual detected city so a Guangzhou trip never displays
 * "起点默认设为「陆家嘴」".
 */
export function fallbackAssumptionFor(field: string, profile: CityProfile): string {
  switch (field) {
    case "start_location":
      return `起点默认设为「${profile.defaultStart}」（${profile.zh}）`;
    case "final_destination":
      return `终点默认设为「${profile.defaultDest}」（${profile.zh}）`;
    case "start_time":
      return "起始时间默认为 12:00";
    case "departure_time":
      return "出发车次/航班时间默认为 22:00";
    default:
      return `字段 ${field} 使用默认值`;
  }
}

export function parseConstraintsRule(userInput: string): ParseResult {
  const profile = detectCity(userInput);
  const { start, end } = locateInCity(profile, userInput);
  const preferences = extractPreferences(userInput);
  const extractedConstraints = extractConstraints(userInput);
  const isLuggage = userInput.includes("行李") || userInput.includes("箱子");
  const isRainy = userInput.includes("下雨") || userInput.includes("雨天");

  const { start: rawStartTime, end: rawEndTime } = extractStartEndTimes(userInput);

  const missing: string[] = [];
  const assumptions: string[] = [];

  if (!start) {
    missing.push("start_location");
    assumptions.push(fallbackAssumptionFor("start_location", profile));
  }
  if (!end) {
    missing.push("final_destination");
    assumptions.push(fallbackAssumptionFor("final_destination", profile));
  }
  if (!rawStartTime) {
    missing.push("start_time");
    assumptions.push(fallbackAssumptionFor("start_time", profile));
  }
  if (!rawEndTime) {
    missing.push("departure_time");
    assumptions.push(fallbackAssumptionFor("departure_time", profile));
  }

  const startTime = rawStartTime || "12:00";
  const endTime = rawEndTime || "22:00";

  const [dh, dm] = endTime.split(":").map(Number);
  const recMin = dh * 60 + dm - 45;
  const recArrival = `${Math.floor(recMin / 60).toString().padStart(2, "0")}:${(recMin % 60).toString().padStart(2, "0")}`;

  const budgetMatch = userInput.match(/(\d+)\s*[元¥￥]/);
  const budget = budgetMatch ? parseInt(budgetMatch[1]) : null;

  const foodPrefs: string[] = [];
  if (userInput.match(/本帮|上海菜/)) foodPrefs.push("本帮菜");
  if (userInput.match(/小吃/)) foodPrefs.push("小吃");
  if (userInput.match(/粤菜|早茶/)) foodPrefs.push("粤菜");
  if (userInput.match(/川菜|火锅/)) foodPrefs.push("川菜");
  if (foodPrefs.length === 0 && preferences.includes("local_food")) {
    // Default to a city-appropriate local cuisine hint instead of Shanghainese
    // for every city.
    if (profile.key === "shanghai") foodPrefs.push("本帮菜");
    else if (profile.key === "guangzhou") foodPrefs.push("粤菜");
    else if (profile.key === "chengdu" || profile.key === "chongqing") foodPrefs.push("川菜");
    else foodPrefs.push("本地菜");
  }

  let walkPref: Constraints["walking_preference"] = "medium";
  if (userInput.match(/少走|不太累|轻松|不想走/)) walkPref = "low";

  const constraints: Constraints = {
    city: profile.en,
    start_location: start || profile.defaultStart,
    start_time: startTime,
    final_destination: end || profile.defaultDest,
    departure_time: endTime,
    recommended_arrival_time: recArrival,
    preferences,
    constraints: extractedConstraints.length > 0 ? extractedConstraints : ["avoid_rushing", "safe_buffer"],
    budget_per_person: budget,
    luggage: isLuggage,
    weather: isRainy ? "rainy" : "unknown",
    walking_preference: walkPref,
    food_preference: foodPrefs,
    plan_style: "balanced",
  };

  let confidence: ParseResult["confidence"] = "high";
  if (missing.length >= 2) confidence = "low";
  else if (missing.length === 1) confidence = "medium";

  return {
    constraints,
    confidence,
    missing,
    assumptions,
    source: "rule",
  };
}

// Backwards-compatible export — returns just the constraints.
export function parseConstraints(userInput: string): Constraints {
  return parseConstraintsRule(userInput).constraints;
}
