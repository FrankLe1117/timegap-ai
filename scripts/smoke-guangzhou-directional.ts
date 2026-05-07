/**
 * Smoke test for the Guangzhou screenshot regression.
 *
 * Bad case from the bug report:
 *   - Stop displayed: "晚餐：珠江新城(地铁站)附近一家早茶小馆"
 *   - Reason: "#local_food #dinner"  (raw planner tags leaking)
 *   - Link label: "在高德打开"        (verified-POI styling on a non-POI)
 *   - Transport leg: full driving/transit chips to a guessed coordinate
 *
 * Root cause: planner's `buildNonShanghaiDirectionalStops` emitted commercial
 * stops *without* `place_kind: "directional"` and with reason set to the raw
 * tag list. The sanitizer's synthetic-name regex capped the prefix at 12 chars,
 * which silently missed long names like the screenshot's 17-char string. The
 * downstream Amap enrichment then geocoded that synthetic name, stamped a
 * marker URL, and the UI rendered it as if it were a verified POI.
 *
 * This suite asserts the post-fix invariants:
 *   1. Planner emits non-Shanghai meal stops with `place_kind: "directional"`
 *      and a clean Chinese reason (no `#local_food #dinner`).
 *   2. Sanitizer leaves the directional name intact, scrubs raw-tag reasons,
 *      and strips coords / amap_url. Transport leg also stays directional.
 *   3. `extractDirectionalIntent(stop, "广州")` returns area="珠江新城" and
 *      category="早茶".
 *   4. With a confirmed Cantonese 早茶 POI in the mock, the resolver upgrades
 *      the stop to a verified POI.
 *   5. With no usable POI, the resolver upgrades to a search-mode placeholder
 *      whose search_query starts with "珠江新城 早茶/粤菜" — never generic
 *      "餐厅", never the original "找一家XX小馆" wording.
 *   6. The transport leg adopts the same search-mode affordance — no
 *      driving/transit chips to a guessed coordinate.
 */
import {
  extractDirectionalIntent,
  resolveDirectionalSuggestions,
  type AmapSearchDeps,
} from "../src/lib/directional-resolver";
import { sanitizePlanResponse } from "../src/lib/place-sanitize";
import { planTimeGapTrip } from "../src/lib/planner";
import type { AmapPoi } from "../src/lib/amap-client";
import type { Constraints } from "../src/types";

function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("PASS:", msg);
}

function buildGuangzhouConstraints(): Constraints {
  return {
    city: "Guangzhou",
    city_cn: "广州",
    start_location: "珠江新城(地铁站)",
    start_time: "12:00",
    final_destination: "广州白云国际机场",
    departure_time: "21:00",
    preferences: ["local_food"],
    constraints: ["avoid_rushing", "safe_buffer"],
    budget_per_person: null,
    luggage: false,
    weather: "unknown",
    walking_preference: "medium",
    food_preference: ["粤菜", "早茶"],
    plan_style: "balanced",
  };
}

async function main() {
  /* ----------------------------------------------------------------------- */
  /* 1. Planner emits clean directional stops                                */
  /* ----------------------------------------------------------------------- */
  const constraints = buildGuangzhouConstraints();
  const raw = planTimeGapTrip(constraints, undefined, undefined, {
    userText: "12点到22点空，珠江新城出发，去白云机场，更本地",
  });

  const balanced = raw.plans[0];
  const dinner = balanced.timeline.find((t) => t.activity_type === "dinner");
  ok(!!dinner, "planner emits a dinner stop");
  if (!dinner) return;

  // 1a. Stop name carries the local cuisine and the start area.
  ok(
    /珠江新城/.test(dinner.place_name),
    `dinner place_name contains 珠江新城 (got "${dinner.place_name}")`,
  );
  ok(
    /早茶|粤菜|茶餐厅/.test(dinner.place_name),
    `dinner place_name carries Cantonese cuisine (got "${dinner.place_name}")`,
  );
  // 1b. place_kind tagged as directional from the planner — that's the gate
  //     downstream sanitize / enrichment / resolver use. The bug was that
  //     this was missing.
  ok(
    dinner.place_kind === "directional",
    `dinner place_kind === "directional" (got "${dinner.place_kind}")`,
  );
  // 1c. Reason is user-facing Chinese, NOT raw planner tags.
  ok(
    !/^#/.test((dinner.reason || "").trim()),
    `dinner reason is not raw tags (got "${dinner.reason}")`,
  );
  ok(
    !/#local_food/.test(dinner.reason || ""),
    `dinner reason does not include #local_food (got "${dinner.reason}")`,
  );
  // 1d. Inbound transport leg is also directional and has no route_options.
  const dinnerIdx = balanced.timeline.indexOf(dinner);
  const inbound = balanced.timeline[dinnerIdx - 1];
  ok(!!inbound && inbound.activity_type === "transport", "inbound leg is transport");
  if (inbound && inbound.activity_type === "transport") {
    ok(
      inbound.place_kind === "directional",
      `inbound leg place_kind === "directional" (got "${inbound.place_kind}")`,
    );
    ok(
      !inbound.route_options || inbound.route_options.length === 0,
      "inbound leg carries no driving/transit chips to a directional placeholder",
    );
  }

  /* ----------------------------------------------------------------------- */
  /* 2. Sanitize keeps directional stops intact, scrubs raw fields           */
  /* ----------------------------------------------------------------------- */
  const sanitized = sanitizePlanResponse(raw);
  const sDinner = sanitized.plans[0].timeline.find((t) => t.activity_type === "dinner")!;
  ok(sDinner.place_kind === "directional", "sanitize keeps directional flag");
  ok(!sDinner.amap_url, "sanitize: no amap_url on directional stop");
  ok(sDinner.lng == null && sDinner.lat == null, "sanitize: no coords on directional stop");
  ok(
    !/^#/.test((sDinner.reason || "").trim()) && !/#local_food/.test(sDinner.reason || ""),
    `sanitize reason has no raw tags (got "${sDinner.reason}")`,
  );

  /* ----------------------------------------------------------------------- */
  /* 3. Intent extraction uses Guangzhou anchors                             */
  /* ----------------------------------------------------------------------- */
  const intent = extractDirectionalIntent(sDinner, "广州");
  ok(intent.area === "珠江新城", `intent.area === "珠江新城" (got "${intent.area}")`);
  ok(
    intent.category === "早茶" || intent.category === "粤菜" || intent.category === "茶餐厅",
    `intent.category is Cantonese-family (got "${intent.category}")`,
  );
  ok(intent.activity === "dinner", "intent.activity preserved");

  /* ----------------------------------------------------------------------- */
  /* 4. Resolver picks a concrete POI when one is available                  */
  /* ----------------------------------------------------------------------- */
  const cantonesePoi: AmapPoi = {
    id: "B0FFGZ001",
    name: "陶陶居(珠江新城店)",
    address: "天河区珠江新城兴民路222号",
    coord: { lng: 113.32, lat: 23.12 },
    type: "餐饮服务;中餐厅;粤菜餐厅",
    district: "天河区",
    cityName: "广州市",
    hasRealId: true,
  };
  const okDeps: AmapSearchDeps = {
    searchByKeyword: async () => [cantonesePoi],
    searchNearby: async () => [cantonesePoi],
  };
  const resolved = await resolveDirectionalSuggestions(sanitized, {
    startCoord: { lng: 113.32, lat: 23.12 },
    city: "广州",
    deps: okDeps,
  });
  const stops = resolved.response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  // First lunch slot wins the POI; second slot stays directional/search.
  const concrete = stops.filter((s) => s.place_kind === "poi");
  ok(concrete.length >= 1, `at least one concrete POI resolved (got ${concrete.length})`);
  ok(
    concrete[0].place_name.includes("陶陶居"),
    `concrete POI name = 陶陶居 (got "${concrete[0].place_name}")`,
  );
  ok(!!concrete[0].amap_url, "concrete POI has amap_url (verified link)");
  // Diagnostics surfaced.
  ok(
    resolved.mealDiagnostics.length >= 2,
    `mealDiagnostics tracks both meal slots (got ${resolved.mealDiagnostics.length})`,
  );
  ok(
    resolved.mealDiagnostics.some((d) => d.outcome === "poi"),
    "diagnostics: at least one poi outcome",
  );

  /* ----------------------------------------------------------------------- */
  /* 5. Resolver falls back to search-mode when no POI is reliable           */
  /* ----------------------------------------------------------------------- */
  const noResultDeps: AmapSearchDeps = {
    searchByKeyword: async () => [],
    searchNearby: async () => [],
  };
  const fallback = await resolveDirectionalSuggestions(sanitized, {
    startCoord: { lng: 113.32, lat: 23.12 },
    city: "广州",
    deps: noResultDeps,
  });
  const fallbackStops = fallback.response.plans[0].timeline.filter(
    (t) => t.activity_type !== "transport" && t.activity_type !== "station_buffer",
  );
  ok(
    fallbackStops.every((s) => s.place_kind !== "poi"),
    "fallback: no stop pretends to be a verified POI",
  );
  const searchStops = fallbackStops.filter((s) => s.place_kind === "search");
  ok(searchStops.length >= 1, `at least one search-mode placeholder (got ${searchStops.length})`);
  for (const s of searchStops) {
    ok(
      !!s.search_url && /uri\.amap\.com\/search/.test(s.search_url),
      `search_url is Amap search link (got ${s.search_url})`,
    );
    ok(
      !!s.search_query && /珠江新城/.test(s.search_query),
      `search_query mentions 珠江新城 (got "${s.search_query}")`,
    );
    ok(
      !!s.search_query && /早茶|粤菜|茶餐厅/.test(s.search_query),
      `search_query carries Cantonese cuisine, not generic 餐厅 (got "${s.search_query}")`,
    );
    ok(
      !/找一家.{0,8}小馆/.test(s.place_name),
      `placeholder name no longer reads as 找一家XX小馆 (got "${s.place_name}")`,
    );
    ok(!s.amap_url, "search-mode stop has no verified amap_url");
    ok(s.lng == null && s.lat == null, "search-mode stop has no coords");
    ok(
      !/^#/.test((s.reason || "").trim()) && !/#local_food/.test(s.reason || ""),
      `search-mode reason has no raw tags (got "${s.reason}")`,
    );
  }
  // Diagnostics include search outcomes.
  ok(
    fallback.mealDiagnostics.some((d) => d.outcome === "search"),
    "diagnostics: at least one search outcome",
  );

  /* ----------------------------------------------------------------------- */
  /* 6. Transport legs to search-mode stops are honest                       */
  /* ----------------------------------------------------------------------- */
  const transports = fallback.response.plans[0].timeline.filter(
    (t) => t.activity_type === "transport",
  );
  for (const leg of transports) {
    if (leg.place_kind !== "search") continue;
    ok(!leg.amap_url, "transport leg to search-mode has no verified amap_url");
    ok(
      Array.isArray(leg.route_options)
        && leg.route_options.length === 1
        && leg.route_options[0].mode === "search",
      `transport leg to search-mode carries single search chip (got ${JSON.stringify(leg.route_options)})`,
    );
    ok(
      leg.route_options![0].label.includes("搜索"),
      `transport leg search chip label reads as 搜索 (got "${leg.route_options![0].label}")`,
    );
  }

  /* ----------------------------------------------------------------------- */
  /* 7. End-to-end: response never carries the bad-case strings              */
  /* ----------------------------------------------------------------------- */
  const allText = JSON.stringify(fallback.response);
  ok(!/#local_food/.test(allText), "no #local_food anywhere in user-facing response");
  ok(!/#dinner\b/.test(allText), "no raw #dinner tag in response");
  // The bare ugly phrase that the screenshot showed must not appear as a
  // user-facing place_name in the resolved response (it can still appear in
  // diagnostics' oldName history — that's an internal field, not rendered).
  for (const plan of fallback.response.plans) {
    for (const item of plan.timeline) {
      if (item.activity_type === "transport") continue;
      ok(
        !/附近一家.{0,8}小馆$/.test(item.place_name),
        `no place_name reads as "附近一家XX小馆" (got "${item.place_name}")`,
      );
    }
  }

  console.log("\nALL GUANGZHOU DIRECTIONAL SMOKE ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
