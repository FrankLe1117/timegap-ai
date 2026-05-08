import { TimelineItem as TimelineItemType } from "@/types";

const activityColors: Record<string, string> = {
  transport: "border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60",
  lunch: "border-orange-300 dark:border-orange-900/70 bg-orange-50 dark:bg-orange-950/30",
  dinner: "border-rose-300 dark:border-rose-900/70 bg-rose-50 dark:bg-rose-950/30",
  city_walk: "border-green-300 dark:border-green-900/70 bg-green-50 dark:bg-green-950/30",
  coffee: "border-amber-300 dark:border-amber-900/70 bg-amber-50 dark:bg-amber-950/30",
  attraction: "border-blue-300 dark:border-blue-900/70 bg-blue-50 dark:bg-blue-950/30",
  station_buffer: "border-purple-300 dark:border-purple-900/70 bg-purple-50 dark:bg-purple-950/30",
  shopping: "border-pink-300 dark:border-pink-900/70 bg-pink-50 dark:bg-pink-950/30",
  rest: "border-teal-300 dark:border-teal-900/70 bg-teal-50 dark:bg-teal-950/30",
};

const activityLabels: Record<string, string> = {
  transport: "交通",
  lunch: "午餐",
  dinner: "晚餐",
  city_walk: "城市漫步",
  coffee: "咖啡",
  attraction: "景点",
  station_buffer: "到站缓冲",
  shopping: "购物",
  rest: "休息",
};

// Tail tokens that indicate a category-style name (e.g. "徐家汇本帮小馆") that
// almost never resolves to a real POI. Mirrors src/lib/place-sanitize.ts so an
// unsanitized server response (older clients, bypass paths) still hides the
// "在高德打开" affordance.
const SYNTHETIC_NAME_RE =
  /^.{0,12}(本帮|小馆|餐厅|餐馆|饭馆|食堂|酒楼|小酒馆|酒馆|咖啡店?|咖啡馆|休息点|快餐区|周边日料|日料|小吃|茶馆|书吧|简餐|商务简餐|本帮简餐|本帮菜|本帮菜餐厅|老字号餐厅|晚餐|午餐|早餐)$/u;

const hasTrustedCoords = (item: TimelineItemType): boolean => {
  return item.lng != null && item.lat != null;
};

const isUnverifiedSyntheticName = (item: TimelineItemType): boolean => {
  if (!item.place_name) return false;
  // Real-candidate stops with a non-suggested reliability are always trusted.
  if (item.source && item.source !== "demo" && item.candidate_reliability !== "suggested") {
    return false;
  }
  return SYNTHETIC_NAME_RE.test(item.place_name);
};

const hasNavablePlace = (item: TimelineItemType): boolean => {
  if (["transport", "station_buffer"].includes(item.activity_type)) return false;
  if (!item.place_name) return false;
  // Directional / search-confirm placeholders never get a verified-POI map
  // link — they are not bound to a concrete place. The search-confirm
  // affordance is rendered separately, see hasSearchAffordance.
  if (item.place_kind === "directional" || item.place_kind === "search") return false;
  // Belt-and-braces: even if the server forgot to mark a stop as directional,
  // refuse to render a map link for an unverified synthetic-style name.
  if (isUnverifiedSyntheticName(item)) return false;
  // Demo stops without coords and without an amap_url have nothing to point at.
  if (!item.amap_url && !hasTrustedCoords(item)) return false;
  return true;
};

const hasSearchAffordance = (item: TimelineItemType): boolean => {
  if (item.activity_type === "transport" || item.activity_type === "station_buffer") return false;
  return item.place_kind === "search" && !!item.search_url;
};

const isTransportLeg = (item: TimelineItemType): boolean => item.activity_type === "transport";

const routeChipClasses: Record<string, string> = {
  transit: "border-sky-200 dark:border-sky-900/60 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-950/60",
  driving: "border-indigo-200 dark:border-indigo-900/60 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-950/60",
  walking: "border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/60",
  search: "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700",
};

export default function TimelineItem({ item, isLast }: { item: TimelineItemType; isLast: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="w-3 h-3 rounded-full bg-blue-500 border-2 border-blue-200 dark:border-blue-900/70 shrink-0 mt-1" />
        {!isLast && <div className="w-0.5 flex-1 bg-slate-200 dark:bg-slate-700 min-h-[20px]" />}
      </div>

      <div className={`flex-1 pb-4 pl-1 ${isLast ? "pb-0" : ""}`}>
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
            {item.start_time} - {item.end_time}
          </span>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">{activityLabels[item.activity_type] || ""}</span>
        </div>
        <div className={`px-3 py-2 rounded-lg border ${activityColors[item.activity_type] || "border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"}`}>
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{item.title}</p>
            {item.source && item.source !== "demo" && item.candidate_reliability !== "suggested" && (
              <span
                className={
                  item.candidate_reliability === "confirmed"
                    ? "text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900/60"
                    : "text-[10px] px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-900/60"
                }
                title={
                  item.candidate_reliability === "confirmed"
                    ? "数据来自高德 POI 接口，已通过校验"
                    : "高德候选，未达到全部校验"
                }
              >
                {item.source === "amap"
                  ? item.candidate_reliability === "confirmed"
                    ? "高德已验证"
                    : "高德候选"
                  : item.candidate_reliability === "confirmed"
                    ? "美团已验证"
                    : "美团候选"}
              </span>
            )}
          </div>
          {item.reason && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{item.reason}</p>
          )}
          {hasNavablePlace(item) && (
            <button
              data-export-ignore="true"
              onClick={(e) => {
                e.stopPropagation();
                const url = item.amap_url
                  || (item.lng != null && item.lat != null
                    ? `https://uri.amap.com/marker?position=${item.lng},${item.lat}&name=${encodeURIComponent(item.place_name)}&src=${encodeURIComponent("Last Stop 尾程")}&coordinate=gaode&callnative=1`
                    : `https://uri.amap.com/search?keyword=${encodeURIComponent(item.place_name)}&city=${encodeURIComponent("上海")}&src=${encodeURIComponent("Last Stop 尾程")}`);
                window.open(url, "_blank");
              }}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              在高德打开
            </button>
          )}
          {hasSearchAffordance(item) && (
            <div className="mt-1.5 flex flex-col gap-0.5" data-export-ignore="true">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (item.search_url) window.open(item.search_url, "_blank");
                }}
                title={
                  item.search_query
                    ? `在高德搜索“${item.search_query}”，从结果中手动选择一家`
                    : "在高德搜索，手动选择一家"
                }
                className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-200 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
                </svg>
                {item.activity_type === "coffee" ? "在高德搜索咖啡馆" : "在高德搜索餐馆"}
              </button>
              <p className="text-[10px] text-slate-400 dark:text-slate-500">
                方向建议，未绑定具体地点{item.search_query ? `（关键字：${item.search_query}）` : ""}
              </p>
            </div>
          )}
          {!hasNavablePlace(item)
            && !hasSearchAffordance(item)
            && !["transport", "station_buffer"].includes(item.activity_type)
            && (item.place_kind === "directional" || isUnverifiedSyntheticName(item)) && (
              <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                方向建议，未绑定具体地点
              </p>
            )}
          {isTransportLeg(item) && item.route_options && item.route_options.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5" data-export-ignore="true">
              {item.route_options.map((opt) => (
                <button
                  key={`${opt.mode}-${opt.url}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(opt.url, "_blank");
                  }}
                  className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border transition-colors ${routeChipClasses[opt.mode] || routeChipClasses.search}`}
                  title={`在高德打开${opt.label}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
