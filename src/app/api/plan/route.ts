import { NextRequest, NextResponse } from "next/server";
import { parseConstraintsSmart } from "@/lib/llm-parser";
import { planTimeGapTrip } from "@/lib/planner";
import { enrichPlanWithAmap } from "@/lib/amap-enrich";
import { buildCandidatePool, isPoolUsable } from "@/lib/candidate-pool";
import { curatePoolWithLlm } from "@/lib/llm-curator";
import { applyCandidatesToPlans } from "@/lib/planner-replace";
import { geocodePlace, isAmapConfigured } from "@/lib/amap-client";
import { sanitizePlanResponse } from "@/lib/place-sanitize";
import {
  applyResolverToConstraints,
  resolveLocationContext,
} from "@/lib/amap-resolver";
import { cityNameForAmap } from "@/lib/city-detect";
import {
  resolveDirectionalSuggestions,
  resolveMealReplacement,
} from "@/lib/directional-resolver";
import {
  repairResponseDuplicates,
  repairResponseDuplicatesWithAmap,
} from "@/lib/plan-dedupe";
import { Constraints, Plan } from "@/types";

const FIELD_LABELS: Record<string, string> = {
  start_location: "起点",
  final_destination: "终点（车站/机场）",
  start_time: "空闲开始时间",
  departure_time: "出发车次/航班时间",
};

function buildClarificationMessage(missing: string[], assumptions: string[]): string {
  const parts: string[] = ["我没完全确认以下信息："];
  parts.push(missing.map((m) => `「${FIELD_LABELS[m] || m}」`).join("、"));
  parts.push("。");
  if (assumptions.length > 0) {
    parts.push("如果直接规划，我会按以下默认处理：");
    parts.push(assumptions.join("；"));
    parts.push("。");
  }
  parts.push("可以补充一下，或者直接说「就按默认规划」。");
  return parts.join("");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userInput, currentConstraints, previousPlans, previousConstraints, allowAssumptions } = body as {
      userInput: string;
      currentConstraints?: Partial<Constraints>;
      extraConstraints?: Record<string, unknown>;
      previousPlans?: Plan[];
      /** Last turn's parsed constraints. Sent by the chat client whenever the
       *  user is refining an existing plan ("避开游客", "增加一顶吃饭"). The
       *  server uses it as a sticky prior so refinements that contain no city
       *  signal don't reset to the Shanghai default. */
      previousConstraints?: Constraints;
      allowAssumptions?: boolean;
    };

    if (!userInput) {
      return NextResponse.json({ error: "userInput is required" }, { status: 400 });
    }

    const parseResult = await parseConstraintsSmart(userInput);

    // Sticky-context fix: when the user is refining an existing plan, fields
    // that the new turn doesn't actually mention should inherit from the
    // previous turn. Without this, a follow-up like "避开游客多的地方"
    // — which carries no city/location/time signal — would re-parse to the
    // Shanghai default and throw away a Nanjing/Guangzhou itinerary.
    //
    // We only inherit fields where the new parse is empty/missing. Anything
    // the user explicitly mentioned in the new turn (e.g. they typed a new
    // city) still wins over the previous value.
    const isReplan = !!previousPlans || !!previousConstraints;
    if (isReplan && previousConstraints) {
      const inheritIfEmpty = <K extends keyof Constraints>(k: K) => {
        const cur = parseResult.constraints[k];
        if (cur === undefined || cur === null || cur === "") {
          (parseResult.constraints[k] as unknown) = previousConstraints[k];
        }
      };
      inheritIfEmpty("city");
      inheritIfEmpty("city_cn");
      inheritIfEmpty("start_location");
      inheritIfEmpty("start_time");
      inheritIfEmpty("final_destination");
      inheritIfEmpty("departure_time");
      // Resolved POIs are expensive to recompute; carry them across when
      // the new turn didn't change start/destination.
      if (
        !parseResult.constraints.start_place &&
        previousConstraints.start_place &&
        parseResult.constraints.start_location === previousConstraints.start_location
      ) {
        parseResult.constraints.start_place = previousConstraints.start_place;
      }
      if (
        !parseResult.constraints.destination_place &&
        previousConstraints.destination_place &&
        parseResult.constraints.final_destination === previousConstraints.final_destination
      ) {
        parseResult.constraints.destination_place = previousConstraints.destination_place;
      }
      // Merge preference/constraint arrays additively so the new turn's
      // "避开游客" stacks on top of last turn's "本地菜".
      if (Array.isArray(previousConstraints.preferences) && previousConstraints.preferences.length > 0) {
        const next = new Set<string>([
          ...previousConstraints.preferences,
          ...(parseResult.constraints.preferences || []),
        ]);
        parseResult.constraints.preferences = Array.from(next);
      }
      if (Array.isArray(previousConstraints.constraints) && previousConstraints.constraints.length > 0) {
        const next = new Set<string>([
          ...previousConstraints.constraints,
          ...(parseResult.constraints.constraints || []),
        ]);
        parseResult.constraints.constraints = Array.from(next);
      }
      if (Array.isArray(previousConstraints.food_preference) && previousConstraints.food_preference.length > 0) {
        const next = new Set<string>([
          ...previousConstraints.food_preference,
          ...(parseResult.constraints.food_preference || []),
        ]);
        parseResult.constraints.food_preference = Array.from(next);
      }
      // The follow-up turn rarely re-states luggage/weather/budget; inherit
      // when current parse left them on their default sentinel values.
      if (parseResult.constraints.luggage === false && previousConstraints.luggage === true) {
        parseResult.constraints.luggage = true;
      }
      if (parseResult.constraints.weather === "unknown" && previousConstraints.weather && previousConstraints.weather !== "unknown") {
        parseResult.constraints.weather = previousConstraints.weather;
      }
      if (parseResult.constraints.budget_per_person === null && previousConstraints.budget_per_person !== null) {
        parseResult.constraints.budget_per_person = previousConstraints.budget_per_person;
      }
    }

    // Amap-driven location resolver. Runs after the rule/LLM parser so it can
    // overwrite weak Shanghai-default guesses with concrete POIs in any Amap-
    // supported city. No-op when AMAP_API_KEY is missing — we keep the parser's
    // city-registry fallback in that case.
    if (isAmapConfigured()) {
      try {
        const ctx = await resolveLocationContext({
          userText: userInput,
          parserCity: parseResult.constraints.city,
          startQuery: parseResult.constraints.start_location,
          destQuery: parseResult.constraints.final_destination,
        });
        if (ctx) {
          parseResult.constraints = applyResolverToConstraints(parseResult.constraints, ctx);
          // Drop now-resolved fields from the missing/assumption lists so we
          // don't ask the user to confirm something Amap already nailed.
          if (ctx.start) {
            parseResult.missing = parseResult.missing.filter((m) => m !== "start_location");
            parseResult.assumptions = parseResult.assumptions.filter((a) => !a.includes("起点默认设为"));
          }
          if (ctx.destination) {
            parseResult.missing = parseResult.missing.filter((m) => m !== "final_destination");
            parseResult.assumptions = parseResult.assumptions.filter((a) => !a.includes("终点默认设为"));
          }
        }
      } catch (err) {
        console.warn("[plan] Amap location resolver failed, keeping parser output:", err);
      }
    }

    // If this is a brand-new request (no previousPlans, no quick-action constraints)
    // and we are missing core fields, ask the user to confirm before planning.
    const isFirstRequest = !previousPlans && !currentConstraints;
    if (
      isFirstRequest &&
      !allowAssumptions &&
      (parseResult.confidence === "low" || parseResult.missing.length >= 2)
    ) {
      return NextResponse.json({
        needsClarification: true,
        parseResult,
        message: buildClarificationMessage(parseResult.missing, parseResult.assumptions),
      });
    }

    const extraConstraints = currentConstraints || {};
    const baseResult = planTimeGapTrip(
      parseResult.constraints,
      extraConstraints,
      previousPlans,
      { userText: userInput },
    );

    // Best-effort Amap enrichment. On any failure or missing key the helper
    // returns the input unchanged, so the demo path keeps working.
    let result = baseResult;
    try {
      result = await enrichPlanWithAmap(baseResult);
    } catch (err) {
      console.warn("[plan] Amap enrichment failed, falling back:", err);
    }

    // Candidate-pool replacement: when AMAP_API_KEY is configured, try to
    // replace demo stops with real candidates and rerank. On any failure or
    // empty pool, this returns the input unchanged.
    let startCoord: { lng: number; lat: number } | null = null;
    if (isAmapConfigured()) {
      try {
        // Reuse the resolver's POIs when available so we don't re-geocode the
        // same string under the wrong (Shanghai) city default.
        const cityForLookup = parseResult.constraints.city_cn || cityNameForAmap(parseResult.constraints.city);
        const cachedStart = parseResult.constraints.start_place
          ? { coord: { lng: parseResult.constraints.start_place.lng, lat: parseResult.constraints.start_place.lat } }
          : null;
        const cachedDest = parseResult.constraints.destination_place
          ? { coord: { lng: parseResult.constraints.destination_place.lng, lat: parseResult.constraints.destination_place.lat } }
          : null;
        const [startPoi, destPoi] = await Promise.all([
          cachedStart ?? geocodePlace(parseResult.constraints.start_location, cityForLookup),
          cachedDest ?? geocodePlace(parseResult.constraints.final_destination, cityForLookup),
        ]);
        startCoord = startPoi?.coord ?? null;
        const rawPool = await buildCandidatePool(parseResult.constraints, {
          startCoord: startPoi?.coord ?? null,
          destCoord: destPoi?.coord ?? null,
        });
        // LLM curator: bumps locally-relevant picks to the front and attaches
        // one-line `local_reason` per pick. Falls back to rawPool when the LLM
        // is unavailable, returns nothing useful, or the candidate whitelist
        // rejects every pick. Never blocks the main path — worst case the user
        // sees the original Amap ordering.
        const pool = await curatePoolWithLlm(rawPool, parseResult.constraints);
        if (isPoolUsable(pool)) {
          const replaced = await applyCandidatesToPlans(result, pool, {
            startCoord: startPoi?.coord ?? null,
            destCoord: destPoi?.coord ?? null,
          });
          result = replaced.response;
          // If we used candidates, surface that in the data-sources line.
          if (replaced.replacedTotal > 0) {
            result = {
              ...result,
              dataSources: {
                ...result.dataSources,
                places:
                  "高德候选点（POI/地理编码）+ 演示城市地点库（兜底）",
                apiReady:
                  "已接入高德 Web Service（路线/POI/地理编码 + 候选点替换），未接入点评/美团",
              },
            };
          }
        }
      } catch (err) {
        console.warn("[plan] Candidate-pool replacement failed, keeping enriched plan:", err);
      }
    }

    // Final defence-in-depth guard. The planner already sanitizes its raw
    // output, but enrichment / candidate replacement can mutate timelines, so
    // we run the same pass on the response that's about to leave the server.
    // It's idempotent — already-sanitized items pass through unchanged.
    let sanitized = sanitizePlanResponse(result);

    // Last-mile upgrade: any directional suggestion left after sanitization
    // (e.g. "黄浦区附近找一家老字号餐厅小馆") gets one more chance to resolve
    // into a concrete Amap POI. When the search returns a reliable POI, the
    // stop gains coords / amap_url; otherwise it stays directional.
    if (isAmapConfigured()) {
      try {
        const resolved = await resolveDirectionalSuggestions(sanitized, {
          startCoord,
        });
        sanitized = resolved.response;
        if (resolved.mealDiagnostics.length > 0) {
          const details = resolved.mealDiagnostics;
          const poiResolved = details.filter((d) => d.outcome === "poi").length;
          const searchFallback = details.filter((d) => d.outcome === "search").length;
          const directionalKept = details.filter((d) => d.outcome === "directional").length;
          sanitized = {
            ...sanitized,
            dataSources: {
              ...sanitized.dataSources,
              mealResolution: {
                attempted: details.length,
                poiResolved,
                searchFallback,
                directionalKept,
                details,
              },
            },
          };
          if (process.env.NODE_ENV !== "production") {
            console.info("[plan] meal-resolution", {
              attempted: details.length,
              poiResolved,
              searchFallback,
              directionalKept,
              details,
            });
          }
        }
      } catch (err) {
        console.warn("[plan] Directional resolution failed, keeping suggestions:", err);
      }
    }

    // Final-guard de-duplication. By this point enrichment, candidate
    // replacement, and directional resolution have all run; if any of them
    // — or a combination — left two concrete stops referencing the same
    // POI in a single plan, the duplicate stop is repaired.
    //
    // When Amap is reachable, we first try to *replace* a duplicate meal
    // stop with a different reliable nearby restaurant — so the user never
    // sees a generic "方向建议" in place of a real restaurant when we could
    // have picked one. Only when no replacement is found do we convert it
    // to a clear "需要手动确认餐馆" placeholder (no map link).
    //
    // Without Amap we fall back to the synchronous repair pass which always
    // converts duplicates to a directional placeholder.
    try {
      if (isAmapConfigured()) {
        const cuisineHints = (sanitized.parsedConstraints.food_preference || []).filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        );
        const city =
          sanitized.parsedConstraints.city_cn ||
          cityNameForAmap(sanitized.parsedConstraints.city);
        const repaired = await repairResponseDuplicatesWithAmap(
          sanitized,
          async ({ duplicate, anchor, usedKeys }) => {
            return resolveMealReplacement({
              activity: duplicate.activity_type,
              anchor,
              area: undefined,
              category: undefined,
              city,
              cuisineHints,
              usedKeys,
            });
          },
          startCoord,
          // Search hints used to build an Amap search URL for the manual-
          // confirm placeholder when no replacement POI was found. Falls back
          // to city + cuisine when we have nothing more specific.
          () => ({
            city,
            cuisine: cuisineHints[0],
            // The resolver doesn't currently surface a structured area for
            // repair duplicates, so we omit it here and let the search query
            // default to "<city> <cuisine|餐厅>".
            area: undefined,
          }),
        );
        sanitized = repaired.response;
      } else {
        const repaired = repairResponseDuplicates(sanitized);
        sanitized = repaired.response;
      }
    } catch (err) {
      console.warn("[plan] Duplicate-repair guard failed, keeping response:", err);
    }

    return NextResponse.json({
      ...sanitized,
      parseMeta: {
        source: parseResult.source,
        confidence: parseResult.confidence,
        assumptions: parseResult.assumptions,
        notes: parseResult.notes,
      },
    });
  } catch (error) {
    console.error("Plan API error:", error);
    return NextResponse.json({ error: "Failed to generate plans" }, { status: 500 });
  }
}
