/**
 * Chinese natural-language time parser → 24-hour "HH:MM".
 *
 * Handles: 下午1点 / 下午一点 / 晚上9点半 / 21点30 / 9点30 / 中午12点 /
 * 凌晨1点 / 早上9:30 / 9:30 etc. Returns null when no time is recognised.
 *
 * Two entry points:
 *   - parseChineseTime(text): first reasonable time in the chunk.
 *   - parseChineseTimeAll(text): every time mention with its char span, useful
 *     for picking the start vs the end occurrence inside a sentence.
 */

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** Convert simple Chinese hour numerals (一..二十三) to a number, else null. */
function cnHourToNum(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 0 && n <= 30 ? n : null;
  }
  // 十 / 十一 / 十二 / 二十 / 二十三
  if (s === "十") return 10;
  if (s.startsWith("十") && s.length === 2) {
    const u = CN_DIGIT[s[1]];
    return u != null ? 10 + u : null;
  }
  if (s.length === 1) {
    const v = CN_DIGIT[s];
    return v != null ? v : null;
  }
  if (s.length === 2 && CN_DIGIT[s[0]] != null && s[1] === "十") {
    return CN_DIGIT[s[0]] * 10;
  }
  if (s.length === 3 && CN_DIGIT[s[0]] != null && s[1] === "十" && CN_DIGIT[s[2]] != null) {
    return CN_DIGIT[s[0]] * 10 + CN_DIGIT[s[2]];
  }
  // single multi-digit fallback (e.g. "十三" already handled; here for safety)
  return null;
}

/** Convert "三十" / "三十五" / "55" → number minutes. */
function cnMinuteToNum(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 0 && n < 60 ? n : null;
  }
  return cnHourToNum(s); // same numeral system, 0-59 expected
}

type Meridiem = "am" | "pm" | "noon" | "midnight" | null;

interface ParseHit {
  hour: number;
  minute: number;
  meridiem: Meridiem;
  /** Char index in the original text where the match started. */
  index: number;
  /** The raw matched substring, for debugging. */
  raw: string;
}

/** All Chinese meridiem prefixes that imply a half-of-day. */
const MERIDIEM_PREFIX = "(凌晨|清晨|早晨|早上|上午|中午|正午|下午|午后|傍晚|晚上|夜里|夜晚|夜间|半夜|深夜|今晚|今早|今夜)";

function meridiemOf(prefix: string | undefined): Meridiem {
  if (!prefix) return null;
  if (/凌晨|半夜|深夜|夜里|夜间/.test(prefix)) return "midnight"; // 0–5 typical
  if (/清晨|早晨|早上|上午|今早/.test(prefix)) return "am";
  if (/中午|正午/.test(prefix)) return "noon";
  if (/下午|午后/.test(prefix)) return "pm";
  if (/傍晚|晚上|夜晚|今晚|今夜/.test(prefix)) return "pm"; // evening is post-noon
  return null;
}

/** Apply a meridiem hint to a 1–12 hour. */
function applyMeridiem(hour: number, meridiem: Meridiem): number {
  if (meridiem === "pm") {
    if (hour >= 1 && hour <= 11) return hour + 12;
    if (hour === 12) return 12; // 下午12点 ≈ noon, conventionally 12:00
    return hour;
  }
  if (meridiem === "noon") {
    if (hour === 12 || hour === 0) return 12;
    if (hour >= 1 && hour <= 6) return hour + 12; // 中午1点 → 13:00
    return hour;
  }
  if (meridiem === "midnight") {
    if (hour === 12) return 0;
    if (hour >= 1 && hour <= 5) return hour; // 凌晨1点 → 01:00
    return hour;
  }
  if (meridiem === "am") {
    if (hour === 12) return 0; // 上午12点 → 00:00 (rare)
    return hour;
  }
  return hour;
}

/**
 * Parse a single Chinese time token starting at `idx` in `text`.
 * Tries patterns in priority order; returns the first that matches.
 */
function findTimes(text: string): ParseHit[] {
  const hits: ParseHit[] = [];
  const seen = new Set<number>(); // dedupe by start index

  // Helper to push a hit if not already present.
  const push = (h: ParseHit) => {
    if (seen.has(h.index)) return;
    seen.add(h.index);
    hits.push(h);
  };

  // 1) HH:MM with optional Chinese meridiem prefix.
  //    "下午 1:30" / "晚上21:30" / "13:00" / "9:30"
  const reColon = new RegExp(
    `${MERIDIEM_PREFIX}?\\s*([0-2]?\\d)\\s*[::]\\s*([0-5]\\d)`,
    "g",
  );
  for (const m of text.matchAll(reColon)) {
    const meridiem = meridiemOf(m[1]);
    let hour = parseInt(m[2], 10);
    const minute = parseInt(m[3], 10);
    if (hour > 23) continue;
    hour = applyMeridiem(hour, meridiem);
    push({ hour, minute, meridiem, index: m.index ?? 0, raw: m[0] });
  }

  // 2) "X点Y分" / "X点Y" / "X点半" / "X点整" with optional prefix.
  //    Hour can be Arabic OR Chinese numeral; minute likewise.
  const HOUR_TOK = "(\\d{1,2}|二十[一二三]?|十[一二]?|[零〇一二两俩三四五六七八九])";
  const MIN_TOK = "(\\d{1,2}|[零〇一二两俩三四五六七八九十]{1,3})";
  const reHourMin = new RegExp(
    `${MERIDIEM_PREFIX}?\\s*${HOUR_TOK}\\s*[点點時时]\\s*(?:(半)|(整)|${MIN_TOK}\\s*分?)?`,
    "g",
  );
  for (const m of text.matchAll(reHourMin)) {
    const meridiem = meridiemOf(m[1]);
    const hRaw = m[2];
    const half = m[3];
    const sharp = m[4];
    const minRaw = m[5];

    const h0 = cnHourToNum(hRaw);
    if (h0 == null) continue;
    if (h0 > 23) continue;

    let minute = 0;
    if (half) minute = 30;
    else if (sharp) minute = 0;
    else if (minRaw) {
      const m0 = cnMinuteToNum(minRaw);
      if (m0 == null || m0 >= 60) continue;
      minute = m0;
    }

    const hour = applyMeridiem(h0, meridiem);
    push({ hour, minute, meridiem, index: m.index ?? 0, raw: m[0] });
  }

  return hits.sort((a, b) => a.index - b.index);
}

function fmt(h: number, m: number): string {
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/**
 * Return all recognised times in `text` as 24-hour "HH:MM" with their char
 * positions. Order: by appearance in the text.
 */
export function parseChineseTimeAll(text: string): { time: string; index: number; meridiem: Meridiem; raw: string }[] {
  if (!text) return [];
  return findTimes(text).map((h) => ({
    time: fmt(h.hour, h.minute),
    index: h.index,
    meridiem: h.meridiem,
    raw: h.raw,
  }));
}

/** Convenience: first time in the text, or null. */
export function parseChineseTime(text: string): string | null {
  const all = parseChineseTimeAll(text);
  return all.length > 0 ? all[0].time : null;
}

/**
 * Pick start and end times from a free-form sentence. We find every time
 * mention in order; the first becomes start, the last (if different) becomes
 * end. When only one time is present we return it as start with no end.
 *
 * If `endHint` is true and only one time is found, treat it as the end.
 */
export function pickStartEnd(text: string): { start: string | null; end: string | null } {
  const hits = parseChineseTimeAll(text);
  if (hits.length === 0) return { start: null, end: null };
  if (hits.length === 1) return { start: hits[0].time, end: null };
  return { start: hits[0].time, end: hits[hits.length - 1].time };
}

/**
 * Given a candidate "HH:MM" produced by an LLM (which sometimes drops the
 * meridiem), look at the *original* free-form text and correct the hour if
 * the original had an explicit Chinese meridiem prefix that disagrees.
 *
 * Example: LLM returns "01:00" but the user wrote "下午1点" — we re-parse
 * the original and prefer "13:00".
 *
 * Returns the (possibly corrected) "HH:MM", or the input if no correction
 * applies.
 */
export function reconcileTimeWithText(
  llmTime: string | null | undefined,
  originalText: string,
  role: "start" | "end",
): string | null {
  const valid = (t: unknown): t is string => typeof t === "string" && /^\d{1,2}:\d{2}$/.test(t);
  if (!originalText) return valid(llmTime) ? normalize(llmTime) : null;

  const hits = parseChineseTimeAll(originalText);
  if (hits.length === 0) return valid(llmTime) ? normalize(llmTime) : null;

  // Prefer the first hit for start, last hit for end. This matches the way
  // users phrase "X点出发 ... Y点离开" on a single line.
  const preferred = role === "end" ? hits[hits.length - 1] : hits[0];

  // If the LLM time is missing/invalid, just use the preferred parse.
  if (!valid(llmTime)) return preferred.time;

  const llmNorm = normalize(llmTime);
  // If LLM agrees, take the LLM value.
  if (llmNorm === preferred.time) return llmNorm;

  // If LLM differs only by meridiem (12-hour ambiguity) AND the original text
  // had an explicit meridiem prefix for that hit, trust the text-derived time.
  const [lh] = llmNorm.split(":").map(Number);
  const [ph, pm] = preferred.time.split(":").map(Number);
  const sameMinute = parseInt(llmNorm.split(":")[1], 10) === pm;
  const meridiemFlip = sameMinute && (Math.abs(lh - ph) === 12 || (lh === 0 && ph === 12) || (lh === 12 && ph === 0));
  if (meridiemFlip && preferred.meridiem) return preferred.time;

  // Otherwise leave the LLM time alone — the LLM may have understood
  // something we didn't (e.g. "明天九点").
  return llmNorm;
}

function normalize(s: string): string {
  const [h, m] = s.split(":").map(Number);
  return fmt(h, m);
}
