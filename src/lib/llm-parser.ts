import { Constraints, ParseResult } from "@/types";
import { fallbackAssumptionFor, parseConstraintsRule } from "./constraint-parser";
import { reconcileTimeWithText } from "./zh-time";
import { detectCity, profileByKey, CityProfile } from "./city-detect";

const SYSTEM_PROMPT = `你是中文出差/旅行尾程规划助手的输入解析器。用户用自然语言描述他在某个中国城市的最后一段空闲时间和偏好，你需要把它解析成结构化 JSON。

输出严格遵循下面的 JSON Schema，不要输出任何额外文字、解释或 Markdown 代码块标记。

{
  "city": string,                      // 用户所在城市的中文名，例如 "上海"、"广州"、"北京"、"成都"、"杭州"、"深圳"、"重庆"、"西安"、"南京"。无法判断时填 ""。
  "start_location": string,            // 起点中文地名，例如 "陆家嘴"、"珠江新城"、"三里屯"。如不能从原文判断，填 ""。
  "start_time": string,                // 24小时制 "HH:MM"，如 "11:30"。无法判断填 ""。
  "final_destination": string,         // 终点车站/机场，例如 "上海虹桥站"、"广州白云国际机场"、"首都机场"。无法判断填 ""。
  "departure_time": string,            // 终点出发/到达时间 "HH:MM"。无法判断填 ""。
  "preferences": string[],             // 从这些枚举里选: relaxed, local_food, not_expensive, city_walk, coffee, indoor, photo, quiet, avoid_tourist
  "constraints": string[],             // 从这些枚举里选: avoid_rushing, safe_buffer, luggage_friendly, rain_friendly, low_walking
  "budget_per_person": number | null,  // 人均预算（人民币元）；没有提到填 null
  "luggage": boolean,                  // 是否带行李
  "weather": "unknown" | "sunny" | "rainy",
  "walking_preference": "low" | "medium" | "high",
  "food_preference": string[],         // 例如 ["本帮菜", "小吃"]
  "plan_style": "balanced" | "low_risk" | "local_experience",
  "missing": string[],                 // 列出哪些字段你无法从原文确信地推断，比如 ["start_time","start_location"]
  "confidence": "high" | "medium" | "low",  // 你对整体解析的信心
  "notes": string                      // 可选：1句话给用户的复述/澄清提示
}

规则：
- 只在原文里出现的信息才填具体值；不要凭空臆造时间、地点。
- 城市要根据用户提到的地点、车站、机场判断：例如 "白云机场" → 广州；"虹桥/浦东" → 上海；"首都机场/大兴机场" → 北京；"双流/天府机场" → 成都。
- 不要把任何城市的输入都默认为上海；如果连城市都判断不出，把 city 留空。
- 如果原文模糊、缺时间、缺地点，把对应字段留空字符串、并加入 "missing"。
- 不要输出英文翻译、不要输出说明文字，只输出 JSON。`;

interface LlmJson {
  city?: string;
  start_location?: string;
  start_time?: string;
  final_destination?: string;
  departure_time?: string;
  preferences?: string[];
  constraints?: string[];
  budget_per_person?: number | null;
  luggage?: boolean;
  weather?: "unknown" | "sunny" | "rainy";
  walking_preference?: "low" | "medium" | "high";
  food_preference?: string[];
  plan_style?: "balanced" | "low_risk" | "local_experience";
  missing?: string[];
  confidence?: "high" | "medium" | "low";
  notes?: string;
}

function tryParseJson(raw: string): LlmJson | null {
  if (!raw) return null;
  // Strip code fences if present.
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as LlmJson;
  } catch {
    // Attempt to extract first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as LlmJson;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isValidTime(s: unknown): s is string {
  return typeof s === "string" && /^\d{1,2}:\d{2}$/.test(s);
}

function normalizeTime(s: string): string {
  const [h, m] = s.split(":").map(Number);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function pad(s: string | undefined): string {
  return isValidTime(s) ? normalizeTime(s) : "";
}

function ruleAssumptionFor(field: string, profile: CityProfile): string {
  return fallbackAssumptionFor(field, profile);
}

function buildResultFromLlm(json: LlmJson, userInput: string): ParseResult {
  const ruleResult = parseConstraintsRule(userInput);
  const ruleFallback = ruleResult.constraints;

  // Decide the city: prefer the LLM's answer when it matches a known profile;
  // otherwise re-detect from the original text. Both paths agree on the same
  // CityProfile so defaults/assumptions stay consistent.
  const detected = detectCity(userInput);
  const llmProfile = json.city && json.city.trim() ? profileByKey(json.city.trim()) : null;
  const profile = llmProfile && llmProfile.key !== "shanghai"
    ? llmProfile
    : (detected.key !== "shanghai" ? detected : (llmProfile || detected));

  const startLoc = json.start_location && json.start_location.trim() ? json.start_location.trim() : "";
  const endLoc = json.final_destination && json.final_destination.trim() ? json.final_destination.trim() : "";
  // Reconcile the LLM's HH:MM with the original text. The LLM occasionally
  // drops the meridiem (returning "01:00" for "下午1点"); the deterministic
  // Chinese parser owns the final say when the user wrote a clear meridiem.
  const startTime = reconcileTimeWithText(pad(json.start_time), userInput, "start") ?? "";
  const endTime = reconcileTimeWithText(pad(json.departure_time), userInput, "end") ?? "";

  const missing = new Set<string>(json.missing || []);
  const assumptions: string[] = [];

  if (!startLoc) {
    missing.add("start_location");
    assumptions.push(ruleAssumptionFor("start_location", profile));
  }
  if (!endLoc) {
    missing.add("final_destination");
    assumptions.push(ruleAssumptionFor("final_destination", profile));
  }
  if (!startTime) {
    missing.add("start_time");
    assumptions.push(ruleAssumptionFor("start_time", profile));
  }
  if (!endTime) {
    missing.add("departure_time");
    assumptions.push(ruleAssumptionFor("departure_time", profile));
  }

  const finalStartTime = startTime || "12:00";
  const finalEndTime = endTime || "22:00";

  const [dh, dm] = finalEndTime.split(":").map(Number);
  const recMin = dh * 60 + dm - 45;
  const recArrival = `${Math.floor(recMin / 60).toString().padStart(2, "0")}:${(recMin % 60).toString().padStart(2, "0")}`;

  const constraints: Constraints = {
    city: profile.en,
    city_cn: profile.zh,
    start_location: startLoc || ruleFallback.start_location,
    start_time: finalStartTime,
    final_destination: endLoc || ruleFallback.final_destination,
    departure_time: finalEndTime,
    recommended_arrival_time: recArrival,
    preferences: Array.isArray(json.preferences) ? json.preferences.filter((p) => typeof p === "string") : ruleFallback.preferences,
    constraints: Array.isArray(json.constraints) && json.constraints.length > 0
      ? json.constraints.filter((c) => typeof c === "string")
      : ruleFallback.constraints,
    budget_per_person: typeof json.budget_per_person === "number" ? json.budget_per_person : null,
    luggage: typeof json.luggage === "boolean" ? json.luggage : ruleFallback.luggage,
    weather: json.weather === "rainy" || json.weather === "sunny" ? json.weather : "unknown",
    walking_preference: json.walking_preference === "low" || json.walking_preference === "high"
      ? json.walking_preference
      : "medium",
    food_preference: Array.isArray(json.food_preference) ? json.food_preference.filter((f) => typeof f === "string") : ruleFallback.food_preference,
    plan_style: json.plan_style === "low_risk" || json.plan_style === "local_experience" ? json.plan_style : "balanced",
  };

  let confidence: ParseResult["confidence"] = json.confidence === "low" || json.confidence === "medium" || json.confidence === "high"
    ? json.confidence
    : "high";
  if (missing.size >= 2 && confidence === "high") confidence = "low";
  else if (missing.size === 1 && confidence === "high") confidence = "medium";

  return {
    constraints,
    confidence,
    missing: Array.from(missing),
    assumptions,
    source: "llm",
    notes: typeof json.notes === "string" ? json.notes : undefined,
  };
}

// LLM provider config — Zhipu (智谱 GLM) by default.
// Switching providers later only requires changing these constants and the
// env var name; the request body is OpenAI-compatible so most Chinese LLM
// vendors (DeepSeek, Qwen, Moonshot) drop in with no other code changes.
const LLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const LLM_MODEL = process.env.ZHIPU_MODEL || "glm-4-flash";
const LLM_TIMEOUT_MS = 12000;

async function callLlm(userInput: string, apiKey: string): Promise<LlmJson | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userInput },
        ],
        temperature: 0.1,
        // Zhipu supports OpenAI-style { type: "json_object" } — we already
        // describe the schema in SYSTEM_PROMPT, so this is enough.
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[llm-parser] Zhipu returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    return tryParseJson(content);
  } catch (err) {
    console.warn("[llm-parser] Zhipu call failed:", err);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function parseConstraintsSmart(userInput: string): Promise<ParseResult> {
  // Prefer Zhipu; fall back to legacy PERPLEXITY_API_KEY name only if someone
  // already set it (kept for backwards compatibility — safe to remove later).
  const apiKey = process.env.ZHIPU_API_KEY || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    return parseConstraintsRule(userInput);
  }

  const json = await callLlm(userInput, apiKey);
  if (!json) {
    const fb = parseConstraintsRule(userInput);
    return { ...fb, notes: "LLM 解析不可用，已使用规则解析回退。" };
  }

  return buildResultFromLlm(json, userInput);
}
