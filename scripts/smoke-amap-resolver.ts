/**
 * Smoke regression test for the Amap-driven location resolver.
 *
 * Locks in the multi-city behavior we promised when shipping the resolver:
 *
 *   - Guangzhou query "珠江新城 → 白云机场" resolves to city 广州市, start
 *     珠江新城, destination 广州白云国际机场, terminalKind = domestic_flight.
 *   - Xi'an query "西安出差 ... 钟楼 ... 西安北站" resolves to city 西安,
 *     start 钟楼 (西安), destination 西安北站, terminalKind = train.
 *   - Ambiguous bare "钟楼" without a city hint must NOT pop into Shanghai —
 *     either the resolver picks a Xi'an POI (because 钟楼 is the well-known
 *     西安 POI Amap returns) or it returns no city; the parser's downstream
 *     missing-info clarification path takes over.
 *   - When AMAP_API_KEY is missing the resolver returns null (caller falls
 *     back to the city-registry path safely).
 *   - applyResolverToConstraints carries city_cn, start_place, and
 *     destination_place onto the Constraints object.
 *
 * Run: node scripts/run-smoke-amap-resolver.cjs
 */
import {
  applyResolverToConstraints,
  resolveLocationContext,
  type AmapResolverDeps,
} from "../src/lib/amap-resolver";
import type { AmapPoi } from "../src/lib/amap-client";
import type { Constraints } from "../src/types";

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
  ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function poi(p: Partial<AmapPoi> & { name: string; lng: number; lat: number }): AmapPoi {
  return {
    id: p.id || `mock:${p.name}`,
    name: p.name,
    coord: { lng: p.lng, lat: p.lat },
    address: p.address,
    cityName: p.cityName,
    cityCode: p.cityCode,
    adcode: p.adcode,
    district: p.district,
    type: p.type,
    hasRealId: p.hasRealId !== false,
  };
}

function buildDeps(table: Record<string, AmapPoi[]>): AmapResolverDeps {
  return {
    isConfigured: () => true,
    searchByKeyword: async (kw) => table[kw.trim()] || [],
    geocodeAddress: async (q) => (table[q.trim()] || [])[0] || null,
    geocodePlace: async (q) => (table[q.trim()] || [])[0] || null,
  };
}

async function run(): Promise<void> {
  // ----- 1) Guangzhou full input ------------------------------------------
  {
    const deps = buildDeps({
      "珠江新城": [
        poi({
          name: "珠江新城",
          lng: 113.327,
          lat: 23.117,
          cityName: "广州市",
          cityCode: "020",
          adcode: "440100",
          district: "天河区",
          type: "商务住宅;商业街区",
        }),
      ],
      "白云机场": [
        poi({
          name: "广州白云国际机场",
          lng: 113.3,
          lat: 23.39,
          cityName: "广州市",
          cityCode: "020",
          adcode: "440111",
          district: "白云区",
          type: "交通设施服务;机场;机场",
        }),
      ],
    });
    const ctx = await resolveLocationContext(
      {
        userText: "广州出差，中午12点在珠江新城收尾，晚上10点白云机场起飞",
        parserCity: "Guangzhou",
        startQuery: "珠江新城",
        destQuery: "白云机场",
      },
      deps,
    );
    ok(ctx !== null, "guangzhou: resolver returns context");
    if (ctx) {
      eq(ctx.cityName, "广州", "guangzhou: cityName normalized to 广州");
      eq(ctx.profile?.key, "guangzhou", "guangzhou: profile = guangzhou");
      eq(ctx.start?.name, "珠江新城", "guangzhou: start name");
      eq(ctx.start?.cityName, "广州市", "guangzhou: start carries 广州市");
      eq(ctx.destination?.name, "广州白云国际机场", "guangzhou: dest normalized via Amap");
      eq(ctx.destination?.terminalKind, "domestic_flight", "guangzhou: dest terminalKind = domestic_flight");
    }
  }

  // ----- 2) Xi'an full input — parser thought Shanghai, resolver wins ----
  {
    const deps = buildDeps({
      "钟楼": [
        poi({
          name: "西安钟楼",
          lng: 108.94,
          lat: 34.26,
          cityName: "西安市",
          cityCode: "029",
          adcode: "610103",
          district: "碑林区",
          type: "风景名胜;文物古迹",
        }),
      ],
      "西安北站": [
        poi({
          name: "西安北站",
          lng: 108.94,
          lat: 34.38,
          cityName: "西安市",
          cityCode: "029",
          adcode: "610114",
          district: "未央区",
          type: "交通设施服务;火车站",
        }),
      ],
    });
    const ctx = await resolveLocationContext(
      {
        userText:
          "西安出差，中午12点在钟楼附近结束，晚上10点从西安北站出发回上海。",
        parserCity: "Xi'an",
        startQuery: "钟楼",
        destQuery: "西安北站",
      },
      deps,
    );
    ok(ctx !== null, "xian: resolver returns context");
    if (ctx) {
      eq(ctx.cityName, "西安", "xian: cityName = 西安 (NOT Shanghai)");
      eq(ctx.profile?.key, "xian", "xian: profile = xian");
      eq(ctx.start?.name, "西安钟楼", "xian: start normalized to 西安钟楼");
      eq(ctx.destination?.name, "西安北站", "xian: dest = 西安北站");
      eq(ctx.destination?.terminalKind, "train", "xian: dest terminalKind = train (火车站 type)");
    }
  }

  // ----- 3) Ambiguous "钟楼" with no city hint — Amap result wins, no Shanghai default
  {
    const deps = buildDeps({
      "钟楼": [
        poi({
          name: "西安钟楼",
          lng: 108.94,
          lat: 34.26,
          cityName: "西安市",
          adcode: "610103",
          type: "风景名胜",
        }),
      ],
    });
    const ctx = await resolveLocationContext(
      {
        userText: "下午1点在钟楼附近结束",
        parserCity: "Shanghai", // weak default from text-less fallback
        startQuery: "钟楼",
        destQuery: "",
      },
      deps,
    );
    ok(ctx !== null, "ambiguous: resolver returns context");
    if (ctx) {
      ok(ctx.cityName !== "上海", `ambiguous 钟楼 must NOT default Shanghai — got ${ctx.cityName}`);
      eq(ctx.cityName, "西安", "ambiguous: Amap-resolved 西安 wins over Shanghai parser default");
      eq(ctx.start?.name, "西安钟楼", "ambiguous: start = 西安钟楼");
    }
  }

  // ----- 4) Confident Shanghai — text mentions 上海, parser & resolver agree
  {
    const deps = buildDeps({
      "陆家嘴": [
        poi({
          name: "陆家嘴",
          lng: 121.5,
          lat: 31.24,
          cityName: "上海市",
          adcode: "310115",
        }),
      ],
      "虹桥": [
        poi({
          name: "上海虹桥站",
          lng: 121.32,
          lat: 31.19,
          cityName: "上海市",
          adcode: "310112",
          type: "交通设施服务;火车站",
        }),
      ],
    });
    const ctx = await resolveLocationContext(
      {
        userText: "上海出差，中午12点在陆家嘴结束，晚上10点虹桥",
        parserCity: "Shanghai",
        startQuery: "陆家嘴",
        destQuery: "虹桥",
      },
      deps,
    );
    ok(ctx !== null, "shanghai-confident: resolver returns context");
    if (ctx) {
      eq(ctx.cityName, "上海", "shanghai-confident: stays 上海");
      eq(ctx.destination?.terminalKind, "train", "shanghai-confident: 虹桥站 → train");
    }
  }

  // ----- 5) Resolver no-op when not configured ----------------------------
  {
    const deps: AmapResolverDeps = {
      isConfigured: () => false,
      searchByKeyword: async () => [],
      geocodeAddress: async () => null,
      geocodePlace: async () => null,
    };
    const ctx = await resolveLocationContext(
      { userText: "西安出差", parserCity: "Shanghai", startQuery: "钟楼", destQuery: "西安北站" },
      deps,
    );
    eq(ctx, null, "no-key: resolver returns null (caller falls back to registry)");
  }

  // ----- 6) applyResolverToConstraints carries fields ---------------------
  {
    const base: Constraints = {
      city: "Shanghai",
      city_cn: "上海",
      start_location: "钟楼",
      start_time: "12:00",
      final_destination: "西安北站",
      departure_time: "22:00",
      preferences: [],
      constraints: [],
      budget_per_person: null,
      luggage: false,
      weather: "unknown",
      walking_preference: "medium",
      food_preference: [],
      plan_style: "balanced",
    };
    const ctx = {
      cityName: "西安",
      profile: null,
      start: {
        name: "西安钟楼",
        lng: 108.94,
        lat: 34.26,
        cityName: "西安市",
        terminalKind: undefined,
        source: "amap_poi" as const,
      },
      destination: {
        name: "西安北站",
        lng: 108.94,
        lat: 34.38,
        cityName: "西安市",
        terminalKind: "train" as const,
        source: "amap_poi" as const,
      },
      amapUsed: true,
    };
    const next = applyResolverToConstraints(base, ctx);
    eq(next.city_cn, "西安", "apply: city_cn updated");
    eq(next.start_location, "西安钟楼", "apply: start_location uses Amap normalized name");
    eq(next.final_destination, "西安北站", "apply: final_destination set");
    ok(next.start_place && next.start_place.lng === 108.94, "apply: start_place attached with coords");
    ok(
      next.destination_place && next.destination_place.terminalKind === "train",
      "apply: destination_place carries terminalKind",
    );
  }

  if (failed === 0) {
    console.log("\nALL AMAP RESOLVER SMOKE ASSERTIONS PASSED");
  } else {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("smoke-amap-resolver crashed:", err);
  process.exit(1);
});
