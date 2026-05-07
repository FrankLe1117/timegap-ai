import { NextRequest, NextResponse } from "next/server";
import { parseConstraints } from "@/lib/constraint-parser";
import { planTimeGapTrip } from "@/lib/planner";
import { Constraints, Plan } from "@/types";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userInput, currentConstraints, previousPlans } = body as {
      userInput: string;
      currentConstraints?: Partial<Constraints>;
      extraConstraints?: Record<string, unknown>;
      previousPlans?: Plan[];
    };

    if (!userInput) {
      return NextResponse.json({ error: "userInput is required" }, { status: 400 });
    }

    const constraints = parseConstraints(userInput);
    const extraConstraints = currentConstraints || {};
    const result = planTimeGapTrip(constraints, extraConstraints, previousPlans);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Plan API error:", error);
    return NextResponse.json({ error: "Failed to generate plans" }, { status: 500 });
  }
}
