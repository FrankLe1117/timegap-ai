import { Constraints, TimeBudget } from "@/types";

interface Props {
  constraints: Constraints;
  timeBudget: TimeBudget;
}

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分`;
}

export default function ParsedConstraintsCard({ constraints, timeBudget }: Props) {
  return (
    <div className="space-y-2.5">
      {/* Constraint summary */}
      <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex items-center gap-6 text-xs">
          <div>
            <span className="text-slate-400">出发</span>
            <p className="font-medium text-slate-800">{constraints.start_location} · {constraints.start_time}</p>
          </div>
          <svg className="w-4 h-4 text-slate-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
          <div>
            <span className="text-slate-400">必须到达</span>
            <p className="font-medium text-slate-800">{constraints.final_destination} · {timeBudget.planning_deadline}</p>
          </div>
          <div>
            <span className="text-slate-400">出发车次</span>
            <p className="font-medium text-slate-800">{constraints.departure_time}</p>
          </div>
        </div>
        {constraints.preferences.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-slate-100">
            <span className="text-[11px] text-slate-400">偏好</span>
            <div className="flex flex-wrap gap-1">
              {constraints.preferences.map((p) => (
                <span key={p} className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded text-[11px]">
                  {p}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="flex gap-1.5 mt-2">
          {constraints.luggage && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 rounded-full text-[11px]">
              携带行李
            </span>
          )}
          {constraints.weather === "rainy" && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-[11px]">
              下雨天
            </span>
          )}
        </div>
      </div>

      {/* Time budget */}
      <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-slate-400">空闲时段</span>
            <p className="font-semibold text-slate-800">{fmt(timeBudget.free_window_min)}</p>
          </div>
          <div>
            <span className="text-slate-400">末程通勤</span>
            <p className="font-medium text-slate-700">约{timeBudget.estimated_final_transfer_min}分钟</p>
          </div>
          <div>
            <span className="text-slate-400">安全余量</span>
            <p className="font-medium text-slate-700">{timeBudget.station_buffer_min}分钟</p>
          </div>
          <div>
            <span className="text-slate-400">最晚出发</span>
            <p className="font-semibold text-red-600">{timeBudget.latest_leave_for_station}</p>
          </div>
        </div>
        {timeBudget.rush_hour_detected && (
          <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5 text-xs text-amber-700">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            已考虑晚高峰影响，通勤时间已自动调整
          </div>
        )}
      </div>
    </div>
  );
}
