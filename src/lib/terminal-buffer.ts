/**
 * Terminal-aware buffer logic for the planner.
 *
 * Why this exists: the original implementation had a single boolean
 * "is airport → 120, else 45" branch. Real users need different lead times
 * for high-speed rail, domestic flights, and international flights — and
 * buffer should react to luggage / weather / rush hour and explicit asks
 * for "提前到站/更稳妥".
 *
 * The output is a structured BufferDecision so the UI can show *why* a
 * specific buffer was chosen, not just the number.
 */

import { Constraints } from "@/types";

export type TerminalKind =
  | "high_speed_rail"
  | "train"
  | "domestic_flight"
  | "international_flight"
  | "generic";

export interface BufferDecision {
  /** Total minutes to budget at the terminal before scheduled departure. */
  buffer_min: number;
  /** Detected terminal type. */
  terminal_kind: TerminalKind;
  /** Base buffer for the terminal kind, before per-trip add-ons. */
  base_min: number;
  /** Per-reason add-ons applied on top of base. Sum equals buffer_min - base_min. */
  addons: { label: string; minutes: number }[];
  /** Short Chinese label for the kind, e.g. "高铁/火车". */
  kind_label: string;
  /** One-line Chinese summary suitable for UI display. */
  reason: string;
}

// International intent. The bare phrase "国际机场" (e.g. "广州白云国际机场") is
// the OFFICIAL Chinese name of most major airports — a domestic flight from
// PVG/PEK/CAN still has "国际" in the airport's name. So we only treat the
// terminal as international when the user explicitly signals an international
// trip (国际航班/出境/海关/护照) or names an international-only sub-terminal
// (T2 / 2号航站楼). Otherwise we default to domestic_flight.
const INTERNATIONAL_HINTS = /国际航班|国际线|国际航线|出境|海关|护照|international\s*flight|t2\b|2号航站楼|2航站楼|跨境/i;
const AIRPORT_HINTS = /机场|airport|航班|飞机|登机|起飞|航站|terminal/i;
const TRAIN_HINTS = /高铁|动车|火车|车站|站$|高速铁路|铁路|G\d|D\d|hongqiao\s*station|railway|train/i;
// Common Chinese terminal names which strongly imply airport even without 机场.
const KNOWN_AIRPORTS = /浦东(?!.*火车)|虹桥t[12]|sha|pvg|hkg|pek|pkx|sky|t1|t2|航站楼/i;

/** Detect terminal kind from the destination string and the user's free-form input. */
export function detectTerminalKind(
  destination: string,
  userText: string,
): TerminalKind {
  const blob = `${destination ?? ""} ${userText ?? ""}`;

  const isAirport =
    AIRPORT_HINTS.test(blob) || KNOWN_AIRPORTS.test(blob);
  const isTrain = TRAIN_HINTS.test(blob);

  if (isAirport && INTERNATIONAL_HINTS.test(blob)) return "international_flight";
  if (isAirport) return "domestic_flight";

  if (isTrain) {
    // High-speed/动车/G/D车次 → high_speed_rail; otherwise generic train.
    if (/高铁|动车|高速铁路|G\d|D\d|高速|hsr/i.test(blob)) return "high_speed_rail";
    return "train";
  }
  return "generic";
}

const BASE_BY_KIND: Record<TerminalKind, number> = {
  high_speed_rail: 45,
  train: 45,
  domestic_flight: 120,
  international_flight: 180,
  generic: 45,
};

const LABEL_BY_KIND: Record<TerminalKind, string> = {
  high_speed_rail: "高铁/火车",
  train: "火车",
  domestic_flight: "国内航班",
  international_flight: "国际航班",
  generic: "终点",
};

function isRushHour(timeMin: number | null | undefined): boolean {
  if (timeMin == null) return false;
  if (timeMin >= 450 && timeMin <= 570) return true; // 7:30–9:30
  if (timeMin >= 1020 && timeMin <= 1170) return true; // 17:00–19:30
  return false;
}

export interface BufferContext {
  /** Minute-of-day for arriving at the terminal; used for rush-hour check. */
  arrivalMin?: number | null;
  /** Free-form user input — used to pick up phrases like "提前到站". */
  userText?: string;
}

export function decideTerminalBuffer(
  constraints: Constraints,
  ctx: BufferContext = {},
): BufferDecision {
  const userText = ctx.userText || "";
  // Prefer the Amap-resolved terminal kind when present (e.g. resolver knows
  // 西安北站 is a 火车站 from POI type) — otherwise fall back to the regex
  // detector against the destination string + user text.
  const resolvedKind = constraints.destination_place?.terminalKind;
  const kind: TerminalKind = resolvedKind || detectTerminalKind(constraints.final_destination, userText);
  let base = BASE_BY_KIND[kind];
  const addons: { label: string; minutes: number }[] = [];

  // User explicitly asks for extra safety — bump base ceiling.
  const wantsExtraSafety =
    constraints.constraints.includes("safe_buffer") ||
    constraints.preferences.includes("avoid_rushing") ||
    /提前到站|更稳妥|更保险|早点到站|多留点时间|宁早不晚/.test(userText);

  if (wantsExtraSafety) {
    if (kind === "high_speed_rail" || kind === "train") {
      // Lift train base to 60. We update base in place so the reason text
      // reads as "基准 60 分钟" rather than as an addon — "提前到站" is a
      // change of plan style, not an additional buffer for a specific risk.
      base = Math.max(base, 60);
    }
  }

  // Luggage / check-in adds time — only meaningful for flights or when explicit.
  if (constraints.luggage) {
    if (kind === "domestic_flight" || kind === "international_flight") {
      addons.push({ label: "托运行李 + 值机", minutes: 20 });
    } else if (kind === "high_speed_rail" || kind === "train") {
      addons.push({ label: "携带行李过安检", minutes: 10 });
    }
  }

  // Weather (rain) slows access roads.
  if (constraints.weather === "rainy") {
    if (kind === "domestic_flight" || kind === "international_flight") {
      addons.push({ label: "雨天接驳", minutes: 15 });
    } else if (kind === "high_speed_rail" || kind === "train") {
      addons.push({ label: "雨天接驳", minutes: 10 });
    }
  }

  // Rush hour at terminal arrival — increases queue / drop-off congestion.
  if (isRushHour(ctx.arrivalMin)) {
    if (kind === "domestic_flight" || kind === "international_flight") {
      addons.push({ label: "晚高峰接驳/安检", minutes: 15 });
    } else if (kind === "high_speed_rail" || kind === "train") {
      addons.push({ label: "晚高峰", minutes: 10 });
    }
  }

  const total = base + addons.reduce((s, a) => s + a.minutes, 0);

  const reasonParts: string[] = [];
  reasonParts.push(`${LABEL_BY_KIND[kind]}基准 ${base} 分钟`);
  for (const a of addons) reasonParts.push(`${a.label} +${a.minutes}`);
  const reason = `${LABEL_BY_KIND[kind]}缓冲 ${total} 分钟（${reasonParts.join("，")}）`;

  return {
    buffer_min: total,
    terminal_kind: kind,
    base_min: base,
    addons,
    kind_label: LABEL_BY_KIND[kind],
    reason,
  };
}
