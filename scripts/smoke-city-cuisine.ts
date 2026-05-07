/**
 * Smoke regression for the city-aware cuisine layer.
 *
 * Locks in:
 *   - Guangzhou input "想体验更本地" maps to 粤菜/早茶/茶餐厅 (NOT 本帮菜).
 *   - Shanghai input "更本地" still maps to 本帮菜.
 *   - 本帮菜 cascade in Guangzhou widens only to 中餐 (no 江浙菜 pollution).
 *   - Shanghai-branded names (沪上阿姨) get a foreign-brand penalty in
 *     Guangzhou and a 0 penalty in Shanghai.
 *   - Planner output for a non-Shanghai city carries directional stops
 *     keyed off the local cuisine, never demo Shanghai POIs (新天地, 外滩).
 *   - Directional cascade in Guangzhou with intent "餐厅" never queries
 *     本帮菜/上海菜.
 *
 * Run: node scripts/run-smoke-city-cuisine.cjs
 */
import { parseConstraintsRule } from "../src/lib/constraint-parser";
import {
  topLocalCuisinesFor,
  generalizeCuisine,
  foreignBrandPenalty,
  localCuisineBoost,
  resolveCityKey,
  isShanghaiCuisine,
} from "../src/lib/city-cuisine";
import {
  buildIntentQueries,
  buildMealCascadeLevels,
} from "../src/lib/directional-resolver";
import {
  generateBalancedPlan,
  generateLocalExperiencePlan,
  calculateTimeBudget,
} from "../src/lib/planner";

let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(
    actual === expected,
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// --- 1. resolveCityKey -----------------------------------------------------
eq(resolveCityKey("广州市"), "guangzhou", "resolveCityKey('广州市') = guangzhou");
eq(resolveCityKey("Guangzhou"), "guangzhou", "resolveCityKey('Guangzhou') = guangzhou");
eq(resolveCityKey("上海"), "shanghai", "resolveCityKey('上海') = shanghai");
eq(resolveCityKey("西安"), "xian", "resolveCityKey('西安') = xian");
eq(resolveCityKey(""), null, "resolveCityKey('') = null");

// --- 2. topLocalCuisinesFor ------------------------------------------------
const gzCuisines = topLocalCuisinesFor("广州", 3);
ok(
  gzCuisines.includes("粤菜") && gzCuisines.includes("早茶"),
  `Guangzhou local cuisines include 粤菜 + 早茶 — got ${JSON.stringify(gzCuisines)}`,
);
ok(
  !gzCuisines.includes("本帮菜") && !gzCuisines.includes("上海菜"),
  `Guangzhou local cuisines DO NOT include 本帮/上海 — got ${JSON.stringify(gzCuisines)}`,
);

const shCuisines = topLocalCuisinesFor("上海", 3);
ok(
  shCuisines.includes("本帮菜"),
  `Shanghai local cuisines include 本帮菜 — got ${JSON.stringify(shCuisines)}`,
);

const xianCuisines = topLocalCuisinesFor("西安", 3);
ok(
  xianCuisines.some((c) => /陕|肉夹馍|凉皮|面馆/.test(c)),
  `Xi'an local cuisines include 陕菜/肉夹馍/凉皮 — got ${JSON.stringify(xianCuisines)}`,
);

const unknown = topLocalCuisinesFor("非已知城市", 3);
ok(
  unknown.includes("本地特色") || unknown.includes("餐厅"),
  `unknown city cuisines fall back to generic — got ${JSON.stringify(unknown)}`,
);
ok(
  !unknown.includes("本帮菜"),
  `unknown city cuisines never include 本帮菜 — got ${JSON.stringify(unknown)}`,
);

// --- 3. isShanghaiCuisine --------------------------------------------------
ok(isShanghaiCuisine("本帮菜"), "isShanghaiCuisine('本帮菜')");
ok(isShanghaiCuisine("上海菜"), "isShanghaiCuisine('上海菜')");
ok(!isShanghaiCuisine("粤菜"), "isShanghaiCuisine('粤菜') = false");

// --- 4. generalizeCuisine: 本帮菜 in Guangzhou must NOT widen to 江浙菜 ---
const benbangInGZ = generalizeCuisine("本帮菜", "广州");
ok(
  !benbangInGZ.includes("江浙菜"),
  `本帮菜 in 广州 cascade does NOT include 江浙菜 — got ${JSON.stringify(benbangInGZ)}`,
);
ok(
  benbangInGZ.includes("中餐"),
  `本帮菜 in 广州 cascade includes 中餐 fallback — got ${JSON.stringify(benbangInGZ)}`,
);

const benbangInSH = generalizeCuisine("本帮菜", "上海");
ok(
  benbangInSH.includes("江浙菜"),
  `本帮菜 in 上海 cascade includes 江浙菜 — got ${JSON.stringify(benbangInSH)}`,
);

// --- 5. foreignBrandPenalty + localCuisineBoost ----------------------------
ok(
  foreignBrandPenalty("沪上阿姨", "广州") > 0,
  "沪上阿姨 in 广州 → foreign brand penalty > 0",
);
eq(
  foreignBrandPenalty("沪上阿姨", "上海"),
  0,
  "沪上阿姨 in 上海 → no penalty",
);
ok(
  foreignBrandPenalty("本帮鲜师傅", "广州") > 0,
  "本帮鲜师傅 in 广州 → foreign brand penalty > 0",
);
eq(
  foreignBrandPenalty("陶陶居", "广州"),
  0,
  "陶陶居 in 广州 → no penalty",
);

ok(
  localCuisineBoost("陶陶居酒家", "餐饮服务;粤菜", "广州") > 0,
  "粤菜 POI in 广州 gets localCuisineBoost > 0",
);
eq(
  localCuisineBoost("某中餐厅", "餐饮服务;中餐厅", "广州"),
  0,
  "Generic 中餐厅 POI gets no Cantonese boost",
);

// --- 6. buildIntentQueries: city-aware bare-餐厅 queries -------------------
const gzGenericQueries = buildIntentQueries(
  { area: "珠江新城", category: "餐厅", activity: "dinner" },
  "广州",
);
ok(
  !gzGenericQueries.some((q) => /本帮|上海菜/.test(q)),
  `Guangzhou intent queries DO NOT contain 本帮/上海菜 — got ${JSON.stringify(gzGenericQueries)}`,
);
ok(
  gzGenericQueries.some((q) => q.includes("粤菜")),
  `Guangzhou intent queries include 粤菜 — got ${JSON.stringify(gzGenericQueries)}`,
);

const shGenericQueries = buildIntentQueries(
  { area: "黄浦区", category: "餐厅", activity: "dinner" },
  "上海",
);
ok(
  shGenericQueries.some((q) => /本帮|上海菜/.test(q)),
  `Shanghai intent queries can mention 本帮菜 — got ${JSON.stringify(shGenericQueries)}`,
);

// --- 7. buildMealCascadeLevels: 本帮菜 in Guangzhou stays 本帮菜 then 中餐, never 江浙菜 ---
const gzBenbangCascade = buildMealCascadeLevels(
  { area: "珠江新城", category: "本帮菜", activity: "dinner" },
  [],
  "广州",
);
const flatGz = gzBenbangCascade.flat();
ok(
  flatGz.some((q) => q.includes("本帮菜")),
  `Guangzhou cascade with intent 本帮菜 still searches 本帮菜 — got ${JSON.stringify(flatGz)}`,
);
ok(
  !flatGz.some((q) => q.includes("江浙菜")),
  `Guangzhou cascade with intent 本帮菜 does NOT widen to 江浙菜 — got ${JSON.stringify(flatGz)}`,
);

// --- 8. buildMealCascadeLevels: 餐厅 in Guangzhou should produce 粤菜 queries ---
const gzGenericCascade = buildMealCascadeLevels(
  { area: "珠江新城", category: "餐厅", activity: "dinner" },
  [],
  "广州",
);
const flatGzGeneric = gzGenericCascade.flat();
ok(
  flatGzGeneric.some((q) => q.includes("粤菜") || q.includes("早茶")),
  `Guangzhou generic cascade includes 粤菜/早茶 — got ${JSON.stringify(flatGzGeneric)}`,
);
ok(
  !flatGzGeneric.some((q) => q.includes("本帮") || q.includes("上海菜")),
  `Guangzhou generic cascade NEVER queries 本帮/上海菜 — got ${JSON.stringify(flatGzGeneric)}`,
);

// --- 9. parser: "更本地" in Guangzhou → 粤菜, in Shanghai → 本帮菜 ----------
const gzParsed = parseConstraintsRule(
  "广州出差，中午12点在珠江新城收尾，晚上10点白云机场起飞。想体验更本地。",
);
ok(
  gzParsed.constraints.food_preference.some((f) => /粤|早茶|茶餐厅/.test(f)),
  `广州 + 更本地 food_preference includes 粤系 — got ${JSON.stringify(gzParsed.constraints.food_preference)}`,
);
ok(
  !gzParsed.constraints.food_preference.includes("本帮菜"),
  `广州 + 更本地 food_preference does NOT include 本帮菜 — got ${JSON.stringify(gzParsed.constraints.food_preference)}`,
);

const shParsed = parseConstraintsRule(
  "上海最后一天，下午1点新天地结束，晚上8点虹桥火车站。想体验更本地。",
);
ok(
  shParsed.constraints.food_preference.includes("本帮菜"),
  `上海 + 更本地 food_preference includes 本帮菜 — got ${JSON.stringify(shParsed.constraints.food_preference)}`,
);

// --- 10. parser: explicit 本帮菜 in 广州 still preserved -------------------
const gzExplicit = parseConstraintsRule(
  "广州出差，中午12点珠江新城，晚上10点白云机场，想吃本帮菜。",
);
ok(
  gzExplicit.constraints.food_preference.includes("本帮菜"),
  `Explicit 本帮菜 in 广州 input is preserved — got ${JSON.stringify(gzExplicit.constraints.food_preference)}`,
);

// --- 11. xian: parser default cuisine ---
const xianParsed = parseConstraintsRule(
  "西安出差，下午2点钟楼出来，晚上9点西安北站发车。想体验更本地。",
);
ok(
  xianParsed.constraints.food_preference.some((f) =>
    /陕|肉夹馍|凉皮|面馆/.test(f),
  ),
  `Xi'an + 更本地 includes 陕系 — got ${JSON.stringify(xianParsed.constraints.food_preference)}`,
);
ok(
  !xianParsed.constraints.food_preference.includes("本帮菜"),
  `Xi'an + 更本地 does NOT include 本帮菜 — got ${JSON.stringify(xianParsed.constraints.food_preference)}`,
);

// --- 12. planner: non-Shanghai city should NOT seed Shanghai demo POIs ---
const tb = calculateTimeBudget(gzParsed.constraints, { userText: "广州" });
const balancedGZ = generateBalancedPlan(gzParsed.constraints, tb, null);
const localGZ = generateLocalExperiencePlan(gzParsed.constraints, tb, null);

const allPlaceNames = [
  ...balancedGZ.timeline.map((t) => t.place_name),
  ...localGZ.timeline.map((t) => t.place_name),
];
const SHANGHAI_DEMO_NAMES = ["新天地", "外滩", "陆家嘴", "南京路步行街", "豫园", "武康路", "田子坊", "思南公馆", "徐家汇"];
const leakedShanghai = allPlaceNames.filter((n) =>
  SHANGHAI_DEMO_NAMES.some((d) => n === d || n.includes(d)),
);
ok(
  leakedShanghai.length === 0,
  `Guangzhou plans do NOT leak Shanghai demo POIs — got ${JSON.stringify(leakedShanghai)}`,
);

// Plans must contain at least one meal stop with a Cantonese-flavored hint.
const mealStopsGZ = [...balancedGZ.timeline, ...localGZ.timeline].filter(
  (t) => t.activity_type === "lunch" || t.activity_type === "dinner",
);
ok(
  mealStopsGZ.length > 0,
  `Guangzhou non-Shanghai plan still has meal stops — got ${mealStopsGZ.length}`,
);
ok(
  mealStopsGZ.some(
    (s) =>
      /粤|早茶|茶餐厅|烧腊/.test(s.title) ||
      /粤|早茶|茶餐厅|烧腊/.test(s.place_name),
  ),
  `At least one Guangzhou meal stop carries 粤/早茶 hint in title/place_name — got ${JSON.stringify(
    mealStopsGZ.map((s) => `${s.title} | ${s.place_name}`),
  )}`,
);
ok(
  !mealStopsGZ.some(
    (s) => /本帮|上海菜/.test(s.title) || /本帮|上海菜/.test(s.place_name),
  ),
  `Guangzhou meal stops never use 本帮/上海菜 wording — got ${JSON.stringify(
    mealStopsGZ.map((s) => `${s.title} | ${s.place_name}`),
  )}`,
);

if (failed === 0) {
  console.log("\nALL CITY-CUISINE SMOKE ASSERTIONS PASSED");
} else {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
