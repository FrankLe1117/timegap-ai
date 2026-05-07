import {
  Constraints, TimeBudget, Plan, CityGraphNode, CityGraphEdge,
  TimelineItem, SuitabilityTags, ReplanChange, PlanResponse, RouteHop,
} from "@/types";
import cityGraph from "@/data/shanghai_city_graph.json";
import { buildRouteOptions } from "./amap-client";
import { decideTerminalBuffer } from "./terminal-buffer";
import { sanitizePlanResponse } from "./place-sanitize";

const { nodes: allNodes, edges: allEdges } = cityGraph as {
  nodes: CityGraphNode[];
  edges: CityGraphEdge[];
};

function timeToMin(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function isRushHour(timeMin: number): boolean {
  if (timeMin >= 450 && timeMin <= 570) return true;
  if (timeMin >= 1020 && timeMin <= 1170) return true;
  return false;
}

function findNodeByName(name: string): CityGraphNode | undefined {
  return allNodes.find((n) => n.name === name);
}

function findNodeIdByName(name: string): string {
  const node = findNodeByName(name);
  return node?.id || name;
}

function getEdge(fromId: string, toId: string): CityGraphEdge | undefined {
  return allEdges.find((e) => e.from === fromId && e.to === toId)
    || allEdges.find((e) => e.to === fromId && e.from === toId);
}

function getTravelTime(fromName: string, toName: string, departureTimeMin: number): {
  minutes: number;
  isRush: boolean;
  mode: string;
  reliability: string;
} {
  const fromId = findNodeIdByName(fromName);
  const toId = findNodeIdByName(toName);
  const edge = getEdge(fromId, toId);

  if (!edge) {
    return { minutes: 40, isRush: isRushHour(departureTimeMin), mode: "地铁/打车", reliability: "low" };
  }

  const rush = isRushHour(departureTimeMin);
  const minutes = rush
    ? Math.ceil(edge.base_min * edge.rush_hour_multiplier + edge.buffer_min)
    : edge.base_min + edge.buffer_min;

  return {
    minutes,
    isRush: rush,
    mode: edge.mode,
    reliability: edge.reliability,
  };
}

export function calculateTimeBudget(
  constraints: Constraints,
  options?: { userText?: string },
): TimeBudget {
  const startMin = timeToMin(constraints.start_time);
  let departMin = timeToMin(constraints.departure_time);

  // Same-day window guard: if depart < start, treat as a parsing miss rather
  // than silently crossing midnight (which used to balloon "01:30→21:30" into
  // a ~20h window). We assume both times are on the same day; if a real
  // overnight gap exists, the user phrases it explicitly elsewhere.
  if (departMin <= startMin) {
    departMin = startMin + 60;
  }

  // Decide the terminal-aware buffer. We do a first pass with a coarse
  // arrival estimate (depart - base), then re-evaluate with the actual
  // expected arrival once travel time is known.
  const userText = options?.userText || "";
  const firstPass = decideTerminalBuffer(constraints, {
    arrivalMin: departMin - 60,
    userText,
  });
  const recArrivalCoarse = departMin - firstPass.buffer_min;
  const finalTransfer = getTravelTime(
    constraints.start_location,
    constraints.final_destination,
    recArrivalCoarse - 40,
  );
  const arrivalAtTerminalEstimate = departMin - firstPass.buffer_min;
  const decision = decideTerminalBuffer(constraints, {
    arrivalMin: arrivalAtTerminalEstimate,
    userText,
  });
  const buffer = decision.buffer_min;

  const recArrival = departMin - buffer;
  const latestLeave = recArrival - finalTransfer.minutes;

  const finalTransferRush = isRushHour(latestLeave);
  let rushNote = "";
  if (finalTransferRush) {
    rushNote = `前往${constraints.final_destination}的时间落在晚高峰时段（17:00–19:30），通勤时间已自动增加。建议将晚餐安排在${decision.kind_label}附近以降低误车风险。`;
  }

  return {
    free_window_min: departMin - startMin,
    station_buffer_min: buffer,
    planning_deadline: minToTime(recArrival),
    estimated_final_transfer_min: finalTransfer.minutes,
    latest_leave_for_station: minToTime(Math.max(latestLeave, startMin)),
    safe_activity_time_min: Math.max(latestLeave - startMin - finalTransfer.minutes, 0),
    rush_hour_detected: finalTransferRush,
    rush_hour_note: rushNote,
    terminal_kind: decision.terminal_kind,
    terminal_kind_label: decision.kind_label,
    buffer_base_min: decision.base_min,
    buffer_addons: decision.addons,
    buffer_reason: decision.reason,
  };
}

function filterNodes(
  constraints: Constraints,
  type?: CityGraphNode["type"]
): CityGraphNode[] {
  let filtered = type ? allNodes.filter((n) => n.type === type) : [...allNodes];

  if (type && type !== "transport") {
    filtered = filtered.filter((n) => n.type !== "transport");
  }

  if (constraints.luggage) filtered = filtered.filter((n) => n.luggage_friendly);
  if (constraints.weather === "rainy") filtered = filtered.filter((n) => n.rain_friendly);
  if (constraints.walking_preference === "low") filtered = filtered.filter((n) => n.walking_intensity !== "high");
  if (constraints.budget_per_person) {
    filtered = filtered.filter(
      (n) => !n.price_per_person || n.price_per_person <= constraints.budget_per_person!)
    ;
  }
  if (constraints.constraints.includes("avoid_tourist")) {
    filtered = filtered.filter((n) => !n.tags.includes("tourist") || n.local_experience_score >= 8);
  }

  return filtered;
}

function scoreNode(node: CityGraphNode, constraints: Constraints): number {
  let score = node.local_experience_score * 2;

  if (constraints.preferences.includes("local_food") &&
    node.tags.some((t) => ["local_food", "shanghainese", "traditional"].includes(t))) score += 10;
  if (constraints.preferences.includes("relaxed") && node.tags.includes("relaxed")) score += 5;
  if (constraints.preferences.includes("city_walk") && node.tags.includes("city_walk")) score += 5;
  if (constraints.luggage && node.luggage_friendly) score += 5;
  if (constraints.weather === "rainy" && node.rain_friendly) score += 5;
  if (node.risk_to_hongqiao_station === "low") score += 3;
  if (node.walking_intensity === "low") score += 2;
  if (node.queue_risk === "low") score += 2;

  return score;
}

function pickTop(
  candidates: CityGraphNode[],
  constraints: Constraints,
  count: number,
  exclude: string[] = []
): CityGraphNode[] {
  return [...candidates]
    .filter((n) => !exclude.includes(n.id))
    .sort((a, b) => scoreNode(b, constraints) - scoreNode(a, constraints))
    .slice(0, count);
}

function buildTimeline(
  constraints: Constraints,
  timeBudget: TimeBudget,
  stops: { node: CityGraphNode; activityType: TimelineItem["activity_type"]; label: string }[]
): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  let currentMin = timeToMin(constraints.start_time);
  let currentLocation = constraints.start_location;

  for (const stop of stops) {
    const travel = getTravelTime(currentLocation, stop.node.name, currentMin);

    if (travel.minutes > 0) {
      const arrivalMin = currentMin + travel.minutes;
      timeline.push({
        start_time: minToTime(currentMin),
        end_time: minToTime(arrivalMin),
        title: `前往${stop.node.name}`,
        place_name: stop.node.name,
        place_id: stop.node.id,
        activity_type: "transport",
        reason: `${travel.mode}，${travel.isRush ? "晚高峰时段" : ""}预计${travel.minutes}分钟`,
        estimated_travel_time_to_next_min: null,
        travel_mode: travel.mode,
        is_rush_hour: travel.isRush,
        route_options: buildRouteOptions(currentLocation, stop.node.name),
      });
      currentMin = arrivalMin;
    }

    const duration = stop.node.suggested_duration_min;
    const endMin = currentMin + duration;
    timeline.push({
      start_time: minToTime(currentMin),
      end_time: minToTime(endMin),
      title: stop.label,
      place_name: stop.node.name,
      place_id: stop.node.id,
      activity_type: stop.activityType,
      reason: stop.node.tags.slice(0, 3).map((t) => `#${t}`).join(" "),
      estimated_travel_time_to_next_min: null,
    });
    currentMin = endMin;
    currentLocation = stop.node.name;
  }

  const finalTravel = getTravelTime(currentLocation, constraints.final_destination, currentMin);
  const arrivalAtStation = currentMin + finalTravel.minutes;
  timeline.push({
    start_time: minToTime(currentMin),
    end_time: minToTime(arrivalAtStation),
    title: `前往${constraints.final_destination}`,
    place_name: constraints.final_destination,
    place_id: findNodeIdByName(constraints.final_destination),
    activity_type: "transport",
    reason: `${finalTravel.mode}，${finalTravel.isRush ? "晚高峰时段，已增加缓冲" : ""}预计${finalTravel.minutes}分钟`,
    estimated_travel_time_to_next_min: finalTravel.minutes,
    travel_mode: finalTravel.mode,
    is_rush_hour: finalTravel.isRush,
    route_options: buildRouteOptions(currentLocation, constraints.final_destination),
  });

  const departMin = timeToMin(constraints.departure_time);
  const bufferReason = timeBudget.buffer_reason
    ? timeBudget.buffer_reason
    : `预留${timeBudget.station_buffer_min}分钟安全余量`;
  timeline.push({
    start_time: minToTime(arrivalAtStation),
    end_time: minToTime(departMin),
    title: "到达终点，等候出发",
    place_name: constraints.final_destination,
    place_id: findNodeIdByName(constraints.final_destination),
    activity_type: "station_buffer",
    reason: bufferReason,
    estimated_travel_time_to_next_min: null,
  });

  return timeline;
}

function computeStationArrivalConfidence(
  timeline: TimelineItem[],
  timeBudget: TimeBudget,
  constraints: Constraints
): number {
  let confidence = 100;

  const stationArrival = timeline.find((t) => t.activity_type === "station_buffer");
  if (stationArrival) {
    const buffer = timeToMin(timeBudget.planning_deadline) - timeToMin(stationArrival.start_time);
    if (buffer < 0) confidence -= 30;
    else if (buffer < 15) confidence -= 15;
    else if (buffer < 30) confidence -= 5;
  }

  const hasRushTransfer = timeline.some((t) => t.is_rush_hour && t.activity_type === "transport");
  if (hasRushTransfer) confidence -= 10;

  if (timeBudget.station_buffer_min < 45) confidence -= 10;

  const hasHighWalk = timeline.some((t) =>
    (t.activity_type === "city_walk" || t.activity_type === "attraction")
  );
  if (hasHighWalk && constraints.luggage) confidence -= 10;

  const dinnerItem = timeline.find((t) => t.activity_type === "dinner");
  if (dinnerItem) {
    const dinnerNode = findNodeByName(dinnerItem.place_name);
    if (dinnerNode?.risk_to_hongqiao_station === "high") confidence -= 10;
  }

  return Math.max(Math.min(confidence, 100), 10);
}

function computeExperienceScore(
  timeline: TimelineItem[],
  constraints: Constraints,
  timeBudget: TimeBudget
): number {
  let score = 50;

  const stops = timeline.filter(
    (t) => !["transport", "station_buffer"].includes(t.activity_type)
  );
  if (stops.length === 0) return 20;

  const localScores = stops
    .map((t) => findNodeByName(t.place_name)?.local_experience_score || 5)
    .filter((s) => s > 0);
  const avgLocal = localScores.length
    ? localScores.reduce((a, b) => a + b, 0) / localScores.length
    : 5;
  score += (avgLocal - 5) * 4;

  const types = new Set(stops.map((s) => s.activity_type));
  score += Math.min(types.size, 4) * 3;

  if (stops.length >= 2 && stops.length <= 4) score += 8;
  else if (stops.length === 1) score -= 5;
  else if (stops.length >= 5) score -= 5;

  if (constraints.preferences.includes("local_food") || constraints.preferences.includes("local_experience")) {
    const localMatches = stops.filter((s) => {
      const node = findNodeByName(s.place_name);
      return node?.tags.some((t) => ["local_food", "shanghainese", "traditional", "city_walk"].includes(t));
    }).length;
    score += localMatches * 4;
  }
  if (constraints.preferences.includes("city_walk")) {
    if (stops.some((s) => s.activity_type === "city_walk")) score += 5;
  }
  if (constraints.preferences.includes("relaxed")) {
    const relaxedStops = stops.filter((s) => {
      const node = findNodeByName(s.place_name);
      return node?.tags.includes("relaxed") || node?.walking_intensity === "low";
    }).length;
    score += relaxedStops * 3;
  }

  if (constraints.walking_preference === "low") {
    const heavyWalk = stops.filter((s) => {
      const node = findNodeByName(s.place_name);
      return node?.walking_intensity === "high";
    }).length;
    score -= heavyWalk * 8;
  }

  if (timeBudget.safe_activity_time_min > 0) {
    const stopMin = stops.reduce(
      (sum, s) => sum + (timeToMin(s.end_time) - timeToMin(s.start_time)),
      0
    );
    const utilization = stopMin / timeBudget.safe_activity_time_min;
    if (utilization >= 0.55 && utilization <= 0.95) score += 6;
    else if (utilization < 0.3) score -= 6;
  }

  return Math.max(Math.min(Math.round(score), 100), 10);
}

function buildRouteChain(
  constraints: Constraints,
  timeline: TimelineItem[]
): RouteHop[] {
  const chain: RouteHop[] = [];
  let prevPlace = constraints.start_location;
  for (const item of timeline) {
    if (item.activity_type === "transport") {
      const travelMin = timeToMin(item.end_time) - timeToMin(item.start_time);
      chain.push({
        from: prevPlace,
        to: item.place_name,
        travel_min: travelMin,
        mode: item.travel_mode,
        is_rush_hour: item.is_rush_hour,
        kind: "leg",
      });
      prevPlace = item.place_name;
    } else if (item.activity_type === "station_buffer") {
      // skip — chain ends at final destination arrival
    } else {
      chain.push({
        from: item.place_name,
        to: item.place_name,
        travel_min: 0,
        kind: "stop",
        stop_duration_min: timeToMin(item.end_time) - timeToMin(item.start_time),
        activity_type: item.activity_type,
      });
      prevPlace = item.place_name;
    }
  }
  return chain;
}

function buildTradeoffSummary(
  planType: Plan["plan_type"],
  constraints: Constraints,
  timeBudget: TimeBudget,
  tags: SuitabilityTags
): string {
  const dest = constraints.final_destination;
  if (planType === "low_risk") {
    return `牺牲一些游览深度，把行程提前向${dest}附近靠拢，把误车风险压到最低。`;
  }
  if (planType === "local_experience") {
    const rushNote = timeBudget.rush_hour_detected ? "晚高峰窗口下" : "时间允许时";
    return `${rushNote}多安排一处本地点位，体验分更高，到站缓冲相应收紧到${timeBudget.station_buffer_min}分钟。`;
  }
  // balanced
  if (tags.station_arrival_confidence >= 80 && tags.experience_score >= 65) {
    return `留出充足缓冲再去${dest}，同时保留一处本地体验，是性价比最高的选择。`;
  }
  return `在到站安全和本地体验之间做了折中，适合不想纠结的出差/旅行最后一天。`;
}

function assessSuitability(
  timeline: TimelineItem[],
  timeBudget: TimeBudget,
  constraints: Constraints
): SuitabilityTags {
  const arrivalItem = timeline[timeline.length - 2];
  const bufferMin = arrivalItem
    ? timeToMin(timeBudget.planning_deadline) - timeToMin(arrivalItem.start_time)
    : 45;

  const hasRush = timeline.some((t) => t.is_rush_hour);
  const walkStops = timeline.filter((t) => t.activity_type === "city_walk").length;
  const confidence = computeStationArrivalConfidence(timeline, timeBudget, constraints);

  const luggageScore = constraints.luggage
    ? timeline.every((t) => {
        const node = findNodeByName(t.place_name);
        return !node || node.luggage_friendly || t.activity_type === "transport" || t.activity_type === "station_buffer";
      }) ? "High" : "Low"
    : "Medium";

  const weatherScore = constraints.weather === "rainy"
    ? timeline.every((t) => {
        const node = findNodeByName(t.place_name);
        return !node || node.rain_friendly || t.activity_type === "transport" || t.activity_type === "station_buffer";
      }) ? "High" : "Low"
    : "Medium";

  return {
    time_safety: bufferMin >= 30 ? "High" : bufferMin >= 15 ? "Medium" : "Low",
    rush_hour_exposure: hasRush ? "High" : "Low",
    walking_intensity: walkStops >= 2 ? "High" : walkStops === 1 ? "Medium" : "Low",
    local_experience: timeline.some((t) => {
      const node = findNodeByName(t.place_name);
      return node && node.local_experience_score >= 8;
    }) ? "High" : "Medium",
    luggage_friendly: luggageScore as "High" | "Medium" | "Low",
    weather_robustness: weatherScore as "High" | "Medium" | "Low",
    station_arrival_confidence: confidence,
    experience_score: computeExperienceScore(timeline, constraints, timeBudget),
  };
}

function checkFailureProtection(
  constraints: Constraints,
  timeBudget: TimeBudget
): string | null {
  const safeMin = timeBudget.safe_activity_time_min;
  if (safeMin < 120) {
    return `仅剩约${Math.floor(safeMin / 60)}小时，考虑到晚高峰和安全余量，建议只在虹桥附近吃一顿饭再休息候车。`;
  }
  if (safeMin < 240 && timeBudget.rush_hour_detected) {
    return `大约${Math.floor(safeMin / 60)}小时的窗口，但晚高峰会占用部分通勤时间，建议控制在1-2个停留点。`;
  }
  return null;
}

export function generateBalancedPlan(
  constraints: Constraints,
  timeBudget: TimeBudget,
  failureNote: string | null
): Plan {
  const attractions = filterNodes(constraints, "attraction");
  const areas = filterNodes(constraints, "area");
  const restaurants = filterNodes(constraints, "restaurant");
  const cafes = filterNodes(constraints, "cafe");

  const lunch = pickTop(
    restaurants.filter((r) => r.meal_period?.includes("lunch")), constraints, 1
  )[0];
  const dinner = pickTop(
    restaurants.filter((r) => r.meal_period?.includes("dinner") && r.id !== lunch?.id), constraints, 1
  )[0];
  const attraction = pickTop(
    [...attractions, ...areas].filter((a) =>
      a.tags.includes("city_walk") || a.tags.includes("relaxed")
    ), constraints, 1
  )[0];
  const cafe = pickTop(cafes, constraints, 1, [attraction?.id || ""])[0];

  const stops: { node: CityGraphNode; activityType: TimelineItem["activity_type"]; label: string }[] = [];
  if (lunch) stops.push({ node: lunch, activityType: "lunch", label: `午餐：${lunch.name}` });
  if (attraction && !failureNote) stops.push({ node: attraction, activityType: "city_walk", label: `${attraction.name}城市漫步` });
  if (cafe && stops.length < 4 && !failureNote) stops.push({ node: cafe, activityType: "coffee", label: `咖啡休息：${cafe.name}` });
  if (dinner) stops.push({ node: dinner, activityType: "dinner", label: `晚餐：${dinner.name}` });

  const timeline = buildTimeline(constraints, timeBudget, stops);
  const tags = assessSuitability(timeline, timeBudget, constraints);
  const routeChain = buildRouteChain(constraints, timeline);

  const explanations: string[] = [];
  explanations.push(`你只剩这一段空档（${Math.floor(timeBudget.safe_activity_time_min / 60)}h${timeBudget.safe_activity_time_min % 60}m 可活动），所以只取 ${stops.length} 个停留点`);
  if (attraction) explanations.push(`${attraction.name} 步行适中、本地评分高，作为主要体验点`);
  if (dinner) {
    if (dinner.risk_to_hongqiao_station === "low") {
      explanations.push(`晚餐放在 ${dinner.name}（靠近${constraints.final_destination}），即使晚高峰也能从容赶车`);
    } else {
      explanations.push(`${dinner.name} 满足本地美食偏好，但末程通勤时间已加宽`);
    }
  }
  explanations.push(`${constraints.departure_time}前预留 ${timeBudget.station_buffer_min} 分钟到站缓冲`);
  if (timeBudget.rush_hour_detected) {
    explanations.push("末程落在晚高峰，已自动放大通勤时间，减少误车概率");
  }

  const tradeoff = buildTradeoffSummary("balanced", constraints, timeBudget, tags);

  return {
    plan_name: "均衡本地路线",
    plan_type: "balanced",
    one_sentence_summary: failureNote || "在到站安全和本地体验之间求最优解的均衡路线。",
    tradeoff_summary: failureNote ? tradeoff : tradeoff,
    suitability_tags: tags,
    timeline,
    route_chain: routeChain,
    latest_leave_for_station: timeBudget.latest_leave_for_station,
    risk_note: failureNote || `在${timeBudget.latest_leave_for_station}之前出发前往${constraints.final_destination}即可安全到达。`,
    backup_suggestion: "如果感觉累了可以跳过咖啡环节，提前到虹桥天地休息。",
    explanation: explanations.join("；") + "。",
    rush_hour_warning: timeBudget.rush_hour_detected ? timeBudget.rush_hour_note : undefined,
  };
}

export function generateLowRiskPlan(
  constraints: Constraints,
  timeBudget: TimeBudget,
  failureNote: string | null
): Plan {
  const restaurants = filterNodes(constraints, "restaurant");
  const cafes = filterNodes(constraints, "cafe");
  const malls = filterNodes(constraints, "mall");
  const attractions = filterNodes(constraints, "attraction");

  const nearStation = (n: CityGraphNode) => n.risk_to_hongqiao_station === "low";
  const dinner = pickTop(restaurants.filter((r) => nearStation(r) && r.meal_period?.includes("dinner")), constraints, 1)[0]
    || pickTop(restaurants.filter((r) => r.meal_period?.includes("dinner")), constraints, 1)[0];
  const mall = pickTop(malls, constraints, 1)[0];
  const cafe = pickTop(cafes.filter(nearStation), constraints, 1)[0] || pickTop(cafes, constraints, 1)[0];
  const midCityAttraction = !failureNote
    ? pickTop(attractions.filter((a) => a.risk_to_hongqiao_station !== "high"), constraints, 1)[0]
    : undefined;

  const stops: { node: CityGraphNode; activityType: TimelineItem["activity_type"]; label: string }[] = [];
  if (midCityAttraction) stops.push({ node: midCityAttraction, activityType: "attraction", label: `${midCityAttraction.name}参观` });
  if (cafe && cafe.id !== midCityAttraction?.id) stops.push({ node: cafe, activityType: "coffee", label: `咖啡休息：${cafe.name}` });
  if (mall && stops.length < 3) stops.push({ node: mall, activityType: "shopping", label: `${mall.name}休息购物` });
  if (dinner) stops.push({ node: dinner, activityType: "dinner", label: `晚餐：${dinner.name}` });

  const timeline = buildTimeline(constraints, timeBudget, stops);
  const tags = assessSuitability(timeline, timeBudget, constraints);
  tags.time_safety = "High";
  tags.station_arrival_confidence = Math.min(tags.station_arrival_confidence + 15, 100);

  const explanations: string[] = [];
  explanations.push(`核心目标：把行程重心提前移到${constraints.final_destination}附近，把误车概率压到最低`);
  if (midCityAttraction) explanations.push(`保留 ${midCityAttraction.name} 作为路上的轻量停留，避免完全无聊`);
  else explanations.push("放弃了中段景点，换取额外的 30+ 分钟到站缓冲");
  if (mall) explanations.push(`${mall.name} 作为带行李/雨天的安全中转点`);
  if (dinner) explanations.push(`晚餐安排在 ${dinner.name}（靠近车站），高峰也能从容到站`);

  const tradeoff = buildTradeoffSummary("low_risk", constraints, timeBudget, tags);

  return {
    plan_name: "稳妥车站路线",
    plan_type: "low_risk",
    one_sentence_summary: failureNote || "牺牲一些游览深度，把行程提前向车站靠拢，最大限度避免误车。",
    tradeoff_summary: tradeoff,
    suitability_tags: tags,
    timeline,
    route_chain: buildRouteChain(constraints, timeline),
    latest_leave_for_station: timeBudget.latest_leave_for_station,
    risk_note: "此方案全程靠近终点站，误车风险极低。",
    backup_suggestion: "如果时间充裕，可以在虹桥天地多逛一会儿。",
    explanation: explanations.join("；") + "。",
    rush_hour_warning: timeBudget.rush_hour_detected ? timeBudget.rush_hour_note : undefined,
  };
}

export function generateLocalExperiencePlan(
  constraints: Constraints,
  timeBudget: TimeBudget,
  failureNote: string | null
): Plan {
  const attractions = filterNodes(constraints, "attraction");
  const areas = filterNodes(constraints, "area");
  const restaurants = filterNodes(constraints, "restaurant");

  const localSpots = [...attractions, ...areas].sort((a, b) => b.local_experience_score - a.local_experience_score);
  const localRestaurants = [...restaurants].sort((a, b) => b.local_experience_score - a.local_experience_score);

  const lunch = localRestaurants.find((r) => r.meal_period?.includes("lunch") && r.tags.includes("local_food"))
    || localRestaurants.find((r) => r.meal_period?.includes("lunch"));
  const attraction1 = localSpots.find((a) => a.local_experience_score >= 8) || localSpots[0];
  const attraction2 = !failureNote
    ? localSpots.find((a) => a.id !== attraction1?.id && a.local_experience_score >= 7) || localSpots.find((a) => a.id !== attraction1?.id)
    : undefined;
  const dinner = localRestaurants.find((r) => r.meal_period?.includes("dinner") && r.id !== lunch?.id)
    || localRestaurants.find((r) => r.meal_period?.includes("dinner"));

  const stops: { node: CityGraphNode; activityType: TimelineItem["activity_type"]; label: string }[] = [];
  if (lunch) stops.push({ node: lunch, activityType: "lunch", label: `午餐：${lunch.name}` });
  if (attraction1) stops.push({ node: attraction1, activityType: "city_walk", label: `${attraction1.name}城市漫步` });
  if (attraction2 && stops.length < 4) stops.push({ node: attraction2, activityType: "city_walk", label: `${attraction2.name}深度探索` });
  if (dinner) stops.push({ node: dinner, activityType: "dinner", label: `晚餐：${dinner.name}` });

  const timeline = buildTimeline(constraints, timeBudget, stops);
  const tags = assessSuitability(timeline, timeBudget, constraints);
  tags.local_experience = "High";

  const explanations: string[] = [];
  explanations.push(`核心目标：在赶车安全边界内，把本地体验做到最满`);
  if (attraction1) explanations.push(`${attraction1.name}（本地评分 ${attraction1.local_experience_score}/10）作为主体验`);
  if (attraction2) explanations.push(`${attraction2.name} 用来加深城市感受，相应吃掉了 ${attraction2.suggested_duration_min} 分钟缓冲`);
  if (dinner) explanations.push(`${dinner.name} 提供地道本地美食，但离 ${constraints.final_destination} 较远，末程通勤需更早出发`);
  if (timeBudget.rush_hour_detected) {
    explanations.push("末程刚好落在晚高峰，已自动放大通勤时间，但相比稳妥方案到站信心更低");
  }

  const tradeoff = buildTradeoffSummary("local_experience", constraints, timeBudget, tags);

  return {
    plan_name: "深度本地体验",
    plan_type: "local_experience",
    one_sentence_summary: failureNote || "在赶车安全边界内把本地体验最大化，适合想真正感受城市的你。",
    tradeoff_summary: tradeoff,
    suitability_tags: tags,
    timeline,
    route_chain: buildRouteChain(constraints, timeline),
    latest_leave_for_station: timeBudget.latest_leave_for_station,
    risk_note: failureNote || `在${timeBudget.latest_leave_for_station}之前出发前往${constraints.final_destination}。`,
    backup_suggestion: "如果时间紧张，可以跳过第二个景点。",
    explanation: explanations.join("；") + "。",
    rush_hour_warning: timeBudget.rush_hour_detected ? timeBudget.rush_hour_note : undefined,
  };
}

function computeReplanChanges(
  oldPlans: Plan[] | undefined,
  newPlans: Plan[],
  constraints: Constraints,
  extraConstraints: Record<string, unknown>
): ReplanChange[] {
  const changes: ReplanChange[] = [];
  const newAllPlaces = newPlans.flatMap((p) => p.timeline.map((t) => t.place_name));
  const oldAllPlaces = oldPlans?.flatMap((p) => p.timeline.map((t) => t.place_name)) || [];

  for (const old of oldAllPlaces) {
    if (!newAllPlaces.includes(old) && !["前往", "到达"].some((k) => old.includes(k))) {
      const node = findNodeByName(old);
      const reasons: string[] = [];
      if (extraConstraints.luggage && node && !node.luggage_friendly) reasons.push("不适合带行李");
      if (extraConstraints.weather === "rainy" && node && !node.rain_friendly) reasons.push("不适合雨天");
      if (extraConstraints.walking_preference === "low" && node && node.walking_intensity === "high") reasons.push("步行强度高");
      changes.push({
        action: "removed",
        detail: reasons.length > 0
          ? `移除了${old}（${reasons.join("、")}）`
          : `移除了${old}`,
      });
    }
  }

  for (const np of newAllPlaces) {
    if (!oldAllPlaces.includes(np) && !["前往", "到达"].some((k) => np.includes(k))) {
      changes.push({ action: "added", detail: `新增了${np}` });
    }
  }

  if (extraConstraints.luggage) {
    changes.push({
      action: "moved",
      detail: "优先选择商场、室内和车站附近地点，方便携带行李",
    });
  }
  if (extraConstraints.weather === "rainy") {
    changes.push({
      action: "replaced",
      detail: "户外城市漫步已替换为室内目的地（如博物馆、商场）",
    });
  }

  return changes.length > 0 ? changes : [{ action: "moved", detail: "已根据新约束重新优化方案" }];
}

export function planTimeGapTrip(
  constraints: Constraints,
  extraConstraints?: Record<string, unknown>,
  previousPlans?: Plan[],
  options?: { userText?: string },
): PlanResponse {
  const merged: Constraints = {
    ...constraints,
    ...(extraConstraints?.preferences ? { preferences: [...constraints.preferences, ...(extraConstraints.preferences as string[])] } : {}),
    ...(extraConstraints?.constraints ? { constraints: [...constraints.constraints, ...(extraConstraints.constraints as string[])] } : {}),
    ...(extraConstraints?.luggage !== undefined ? { luggage: extraConstraints.luggage as boolean } : {}),
    ...(extraConstraints?.weather !== undefined ? { weather: extraConstraints.weather as Constraints["weather"] } : {}),
    ...(extraConstraints?.walking_preference !== undefined ? { walking_preference: extraConstraints.walking_preference as Constraints["walking_preference"] } : {}),
    ...(extraConstraints?.budget_per_person !== undefined ? { budget_per_person: extraConstraints.budget_per_person as number } : {}),
  };

  const timeBudget = calculateTimeBudget(merged, { userText: options?.userText });
  const failureNote = checkFailureProtection(merged, timeBudget);

  const plans: Plan[] = [
    generateBalancedPlan(merged, timeBudget, failureNote),
    generateLowRiskPlan(merged, timeBudget, failureNote),
    generateLocalExperiencePlan(merged, timeBudget, failureNote),
  ];

  const replanChanges = previousPlans
    ? computeReplanChanges(previousPlans, plans, merged, extraConstraints || {})
    : undefined;

  const raw: PlanResponse = {
    parsedConstraints: merged,
    timeBudget,
    plans,
    replanChanges,
    dataSources: {
      places: "演示版上海城市地点库（35+ 内置地点）",
      travelTimes: "演示版交通图，含晚高峰倍率与缓冲时间估算",
      apiReady: "高德路线/POI 在配置 AMAP_API_KEY 后启用；未接入点评/美团",
      routesSource: "demo",
      amapConfigured: false,
    },
  };

  // Sanitize synthetic-looking demo stops (e.g. "徐家汇本帮小馆") into
  // directional suggestions before exposing the response. Real candidate
  // replacements happen later in the pipeline and bypass this gate.
  return sanitizePlanResponse(raw, (name) => findNodeByName(name)?.area);
}
