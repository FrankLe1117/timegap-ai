/**
 * LLM-curator: 把高德返回的候选池交给 GLM 做"本地化精选 + 推荐理由"。
 *
 * 关键设计原则（演示稳定性 > 一切）：
 *
 *  1. **绝不让 LLM 编店名**
 *     prompt 中只允许 LLM 引用我们传进去的 poi_id。回包后用白名单校验，
 *     LLM 给的 poi_id 不在 whitelist 里直接丢弃这条 pick。
 *
 *  2. **零侵入 fallback**
 *     - LLM key 未配置 → 不调用，原样返回 pool
 *     - HTTP 失败 / 超时 / 非法 JSON → 原样返回 pool
 *     - 白名单一条都没过 → 原样返回 pool
 *     主链路（高德 + planner + 高德路线验证）任何情况下都不受影响。
 *
 *  3. **进程内缓存**
 *     同一组（city + 偏好 + 候选 id 列表）哈希后缓存 5 分钟，演示来回点
 *     "重新规划"不重复烧 token、不增加延迟。
 *
 *  4. **多型号兼容**
 *     ZHIPU_MODEL 可选 glm-4-flash / glm-4-air / glm-4-plus / glm-4.6 /
 *     glm-5.1。请求格式都是 OpenAI 兼容，差别只在能力和价格。
 */
import type { Candidate, CandidateCategory, CandidatePool } from "./candidate-pool";
import type { Constraints } from "@/types";

const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const CURATOR_TIMEOUT_MS = 9000;
const CURATOR_CACHE_TTL_MS = 5 * 60 * 1000;
/** Per-category cap when sending to LLM. Keeps prompt bounded + cheap. */
const PER_CATEGORY_INPUT_CAP = 8;
/** How many picks the LLM is asked to mark per category. */
const PER_CATEGORY_PICK_CAP = 3;

const SYSTEM_PROMPT = `你是一个懂"中国城市本地玩法"的资深选店人。你的任务是从用户在某座中国城市的最后几小时里、由真实地图 API 返回的候选店铺/景点列表中，挑出最贴近用户调性、本地人会推荐的那几个。

【硬约束 — 违反任意一条都视为失败】
1. 你**只能**从我给你的候选列表里挑（按 poi_id 引用）。绝对不要新增、修改、合并候选。
2. 你**不能**修改任何候选的 name、address、coord——这些是地图 API 的真实数据。
3. 输出的 JSON 必须严格符合下面的 schema，不要包含 markdown、不要多余文字。
4. reason 必须用一句话（不超过 28 字）的本地人口吻，体现这家"为什么对得起用户的偏好"。不要写"地段好/服务好/性价比高"这种万金油。
5. 当一个分类下没有合适的候选，留空数组即可，不要硬挑。

【挑选审美】
- 用户说"不要太网红/不要游客向" → 优先小档口、街坊店、老字号本店，避开抖音热度高的连锁
- 用户说"想要本地特色" → 优先这座城市独有的菜系/小吃
- 用户带行李 / 时间紧 → 优先快、好进出、离地铁近的
- 用户说"安静/松弛" → 避开排队店
- 评分理由要带"地名/年代/吃法"等细节，让人一看就知道是本地人说的话
- 不要一上来就推荐当地最知名的连锁老字号（除非用户没有别的偏好）

【输出 schema】
{
  "picks": {
    "restaurant": [{ "poi_id": "...", "reason": "..." }, ...],
    "cafe": [{ "poi_id": "...", "reason": "..." }, ...],
    "scenic": [{ "poi_id": "...", "reason": "..." }, ...],
    "indoor": [{ "poi_id": "...", "reason": "..." }, ...],
    "station_friendly": [{ "poi_id": "...", "reason": "..." }, ...]
  }
}`;

/** Curator-friendly summary of a single candidate. */
interface CandidateBrief {
  poi_id: string;
  name: string;
  category: CandidateCategory;
  district?: string;
  raw_type?: string;
}

interface LlmPickEntry {
  poi_id?: string;
  reason?: string;
}

interface LlmResponse {
  picks?: Partial<Record<CandidateCategory, LlmPickEntry[]>>;
}

interface CacheEntry {
  expiresAt: number;
  result: LlmResponse;
}

const cache = new Map<string, CacheEntry>();

function pickModel(): string {
  return process.env.ZHIPU_MODEL || "glm-4-flash";
}

function getApiKey(): string | null {
  return process.env.ZHIPU_API_KEY || process.env.PERPLEXITY_API_KEY || null;
}

function briefOf(c: Candidate): CandidateBrief {
  return {
    poi_id: c.poi_id || c.id,
    name: c.name,
    category: c.category,
    district: c.district,
    raw_type: c.raw_type,
  };
}

function buildUserMessage(constraints: Constraints, briefs: CandidateBrief[]): string {
  const city = constraints.city_cn || constraints.city || "未知城市";
  const prefs = [
    ...(constraints.preferences || []),
    ...(constraints.food_preference || []),
  ].filter(Boolean);
  const constraintsList = constraints.constraints || [];
  const styleLabel = constraints.plan_style || "balanced";
  const luggage = constraints.luggage ? "带行李" : "无行李";
  const walking = constraints.walking_preference || "medium";

  // Group briefs by category so the model sees the structure clearly.
  const byCat: Record<CandidateCategory, CandidateBrief[]> = {
    restaurant: [],
    cafe: [],
    scenic: [],
    indoor: [],
    station_friendly: [],
  };
  for (const b of briefs) byCat[b.category].push(b);

  const sections = (Object.keys(byCat) as CandidateCategory[])
    .filter((k) => byCat[k].length > 0)
    .map((k) => {
      const lines = byCat[k].map(
        (b, i) =>
          `  ${i + 1}. poi_id="${b.poi_id}"  name="${b.name}"  ${
            b.district ? `district="${b.district}"  ` : ""
          }${b.raw_type ? `type="${b.raw_type}"` : ""}`
      );
      return `[${k}]\n${lines.join("\n")}`;
    })
    .join("\n\n");

  return `城市：${city}
风格倾向：${styleLabel}
偏好：${prefs.length ? prefs.join("、") : "（无明确偏好）"}
硬约束：${constraintsList.length ? constraintsList.join("、") : "（无）"}
行李：${luggage} · 步行倾向：${walking}

候选列表（按 poi_id 引用）：

${sections}

请从每个分类里最多挑 ${PER_CATEGORY_PICK_CAP} 个，按你认为的"本地人优先级"排序，给出严格符合 schema 的 JSON。`;
}

function hashCacheKey(constraints: Constraints, briefs: CandidateBrief[]): string {
  const ids = briefs
    .map((b) => `${b.category}:${b.poi_id}`)
    .sort()
    .join("|");
  const prefs = [
    ...(constraints.preferences || []),
    ...(constraints.food_preference || []),
    ...(constraints.constraints || []),
    constraints.plan_style || "",
    constraints.luggage ? "lug" : "nolug",
  ]
    .sort()
    .join(",");
  const city = constraints.city_cn || constraints.city || "";
  return `${city}::${prefs}::${ids}`;
}

function tryParseJson(text: string): LlmResponse | null {
  // GLM in json_object mode usually returns clean JSON. But strip ```json fences
  // defensively in case the model regresses.
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/g, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object") return parsed as LlmResponse;
  } catch {
    /* fall through */
  }
  return null;
}

async function callZhipuCurator(
  constraints: Constraints,
  briefs: CandidateBrief[],
  apiKey: string,
): Promise<LlmResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CURATOR_TIMEOUT_MS);
  try {
    const res = await fetch(ZHIPU_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: pickModel(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(constraints, briefs) },
        ],
        temperature: 0.4,
        // Some Zhipu models (notably glm-4.6 / glm-5.1) accept json_object;
        // older ones may ignore it. SYSTEM_PROMPT already pins the schema so
        // both paths still produce parseable output.
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[llm-curator] Zhipu returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    return tryParseJson(content);
  } catch (err) {
    console.warn("[llm-curator] Zhipu call failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Take a candidate pool, ask the LLM to pick + reason about it, and return a
 * NEW pool where:
 *  - LLM-picked candidates are bumped to the front of their category
 *  - Each picked candidate carries `local_reason` + `llm_picked = true`
 *  - All other candidates pass through unchanged
 *
 * If LLM is unavailable for any reason, returns the pool unchanged.
 *
 * Never mutates the input pool.
 */
export async function curatePoolWithLlm(
  pool: CandidatePool,
  constraints: Constraints,
): Promise<CandidatePool> {
  const apiKey = getApiKey();
  if (!apiKey) return pool;
  if (!pool.hasRealData) return pool;

  // Collect briefs respecting per-category cap to keep token budget bounded.
  const briefs: CandidateBrief[] = [];
  const whitelist = new Map<string, Candidate>(); // poi_id → candidate
  (Object.keys(pool.byCategory) as CandidateCategory[]).forEach((cat) => {
    const list = pool.byCategory[cat]
      .filter((c) => c.allow_in_itinerary)
      .slice(0, PER_CATEGORY_INPUT_CAP);
    for (const c of list) {
      const id = c.poi_id || c.id;
      // Defend against duplicate poi_ids across categories — keep first seen.
      if (!whitelist.has(id)) {
        whitelist.set(id, c);
        briefs.push(briefOf(c));
      }
    }
  });

  if (briefs.length === 0) return pool;

  const cacheKey = hashCacheKey(constraints, briefs);
  let llm: LlmResponse | null = null;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    llm = hit.result;
  } else {
    llm = await callZhipuCurator(constraints, briefs, apiKey);
    if (llm) {
      cache.set(cacheKey, {
        result: llm,
        expiresAt: Date.now() + CURATOR_CACHE_TTL_MS,
      });
    }
  }

  if (!llm || !llm.picks) return pool;

  // Validate every pick against the whitelist + dedupe on poi_id.
  const annotations = new Map<string, string>(); // poi_id → reason
  const orderedPicks: Record<CandidateCategory, string[]> = {
    restaurant: [],
    cafe: [],
    scenic: [],
    indoor: [],
    station_friendly: [],
  };

  let pickedAny = false;
  (Object.keys(orderedPicks) as CandidateCategory[]).forEach((cat) => {
    const entries = llm!.picks?.[cat];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const id = typeof entry?.poi_id === "string" ? entry.poi_id.trim() : "";
      const reason = typeof entry?.reason === "string" ? entry.reason.trim() : "";
      if (!id || !reason) continue;
      if (!whitelist.has(id)) continue; // hallucinated id — drop
      if (annotations.has(id)) continue; // dedupe across categories
      // Reject reasons that are obviously empty/placeholder. Keep it short.
      const trimmed = reason.length > 60 ? reason.slice(0, 60) + "…" : reason;
      annotations.set(id, trimmed);
      orderedPicks[cat].push(id);
      pickedAny = true;
    }
  });

  if (!pickedAny) return pool;

  // Build a new pool. For each category, picked candidates appear first (in
  // LLM order), followed by the rest in their original order.
  const newByCategory: Record<CandidateCategory, Candidate[]> = {
    restaurant: [],
    cafe: [],
    scenic: [],
    indoor: [],
    station_friendly: [],
  };
  (Object.keys(pool.byCategory) as CandidateCategory[]).forEach((cat) => {
    const original = pool.byCategory[cat];
    const pickedIds = new Set(orderedPicks[cat]);
    const pickedFront: Candidate[] = [];
    const rest: Candidate[] = [];
    for (const c of original) {
      const id = c.poi_id || c.id;
      const reason = annotations.get(id);
      if (reason) {
        pickedFront.push({ ...c, local_reason: reason, llm_picked: true });
      } else {
        rest.push(c);
      }
    }
    // Sort pickedFront by the LLM's order.
    pickedFront.sort(
      (a, b) =>
        orderedPicks[cat].indexOf(a.poi_id || a.id) -
        orderedPicks[cat].indexOf(b.poi_id || b.id),
    );
    newByCategory[cat] = [...pickedFront, ...rest];
  });

  return {
    byCategory: newByCategory,
    hasRealData: pool.hasRealData,
    sources: pool.sources,
  };
}

/** Test/debug helper — clears the in-process cache. */
export function _clearCuratorCache(): void {
  cache.clear();
}
