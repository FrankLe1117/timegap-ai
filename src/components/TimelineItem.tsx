import { TimelineItem as TimelineItemType } from "@/types";

const activityColors: Record<string, string> = {
  transport: "border-slate-300 bg-slate-50",
  lunch: "border-orange-300 bg-orange-50",
  dinner: "border-rose-300 bg-rose-50",
  city_walk: "border-green-300 bg-green-50",
  coffee: "border-amber-300 bg-amber-50",
  attraction: "border-blue-300 bg-blue-50",
  station_buffer: "border-purple-300 bg-purple-50",
  shopping: "border-pink-300 bg-pink-50",
  rest: "border-teal-300 bg-teal-50",
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

const hasNavablePlace = (item: TimelineItemType): boolean => {
  return !["transport", "station_buffer"].includes(item.activity_type) && !!item.place_name;
};

export default function TimelineItem({ item, isLast }: { item: TimelineItemType; isLast: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="w-3 h-3 rounded-full bg-blue-500 border-2 border-blue-200 shrink-0 mt-1" />
        {!isLast && <div className="w-0.5 flex-1 bg-slate-200 min-h-[20px]" />}
      </div>

      <div className={`flex-1 pb-4 pl-1 ${isLast ? "pb-0" : ""}`}>
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-xs font-mono text-slate-500">
            {item.start_time} - {item.end_time}
          </span>
          <span className="text-[11px] text-slate-400">{activityLabels[item.activity_type] || ""}</span>
        </div>
        <div className={`px-3 py-2 rounded-lg border ${activityColors[item.activity_type] || "border-slate-200 bg-white"}`}>
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-slate-800">{item.title}</p>
            {item.source && item.source !== "demo" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200">
                {item.source === "amap" ? "高德" : "美团"}
              </span>
            )}
          </div>
          {item.reason && (
            <p className="text-xs text-slate-500 mt-0.5">{item.reason}</p>
          )}
          {hasNavablePlace(item) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const url = item.amap_url
                  || (item.lng != null && item.lat != null
                    ? `https://uri.amap.com/marker?position=${item.lng},${item.lat}&name=${encodeURIComponent(item.place_name)}&src=TimeGap%20AI&coordinate=gaode&callnative=1`
                    : `https://uri.amap.com/search?keyword=${encodeURIComponent(item.place_name)}&city=${encodeURIComponent("上海")}&src=TimeGap%20AI`);
                window.open(url, "_blank");
              }}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              在高德打开
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
