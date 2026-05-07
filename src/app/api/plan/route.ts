import { NextRequest, NextResponse } from "next/server";
import { parseConstraintsSmart } from "@/lib/llm-parser";
import { planTimeGapTrip } from "@/lib/planner";
import { enrichPlanWithAmap } from "@/lib/amap-enrich";
import { buildCandidatePool, isPoolUsable } from "@/lib/candidate-pool";
import { applyCandidatesToPlans } from "@/lib/planner-replace";
import { geocodePlace, isAmapConfigured } from "@/lib/amap-client";
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
    const { userInput, currentConstraints, previousPlans, allowAssumptions } = body as {
      userInput: string;
      currentConstraints?: Partial<Constraints>;
      extraConstraints?: Record<string, unknown>;
      previousPlans?: Plan[];
      allowAssumptions?: boolean;
    };

    if (!userInput) {
      return NextResponse.json({ error: "userInput is required" }, { status: 400 });
    }

    const parseResult = await parseConstraintsSmart(userInput);

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
    const baseResult = planTimeGapTrip(parseResult.constraints, extraConstraints, previousPlans);

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
    if (isAmapConfigured()) {
      try {
        const [startPoi, destPoi] = await Promise.all([
          geocodePlace(parseResult.constraints.start_location),
          geocodePlace(parseResult.constraints.final_destination),
        ]);
        const pool = await buildCandidatePool(parseResult.constraints, {
          startCoord: startPoi?.coord ?? null,
          destCoord: destPoi?.coord ?? null,
        });
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

    return NextResponse.json({
      ...result,
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
