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
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 px-4 py-3">
        <div className="flex items-center gap-6 text-xs">
          <div>
            <span className="text-slate-400 dark:text-slate-500">出发</span>
            <p className="font-medium text-slate-800 dark:text-slate-200">{constraints.start_location} · {constraints.start_time}</p>
          </div>
          <svg className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
          <div>
            <span className="text-slate-400 dark:text-slate-500">必须到达</span>
            <p className="font-medium text-slate-800 dark:text-slate-200">{constraints.final_destination} · {timeBudget.planning_deadline}</p>
          </div>
          <div>
            <span className="text-slate-400 dark:text-slate-500">出发车次</span>
            <p className="font-medium text-slate-800 dark:text-slate-200">{constraints.departure_time}</p>
          </div>
        </div>
        {constraints.preferences.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <span className="text-[11px] text-slate-400 dark:text-slate-500">偏好</span>
            <div className="flex flex-wrap gap-1">
              {constraints.preferences.map((p) => (
                <span key={p} className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-300 rounded text-[11px]">
                  {p}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="flex gap-1.5 mt-2">
          {constraints.luggage && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 rounded-full text-[11px]">
              携带行李
            </span>
          )}
          {constraints.weather === "rainy" && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded-full text-[11px]">
              下雨天
            </span>
          )}
        </div>
      </div>

      {/* Time budget */}
      <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 px-4 py-3">
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-slate-400 dark:text-slate-500">空闲时段</span>
            <p className="font-semibold text-slate-800 dark:text-slate-200">{fmt(timeBudget.free_window_min)}</p>
          </div>
          <div>
            <span className="text-slate-400 dark:text-slate-500">末程通勤</span>
            <p className="font-medium text-slate-700 dark:text-slate-300">约{timeBudget.estimated_final_transfer_min}分钟</p>
          </div>
          <div>
            <span className="text-slate-400 dark:text-slate-500">{timeBudget.terminal_kind_label || "终点"}缓冲</span>
            <p className="font-medium text-slate-700 dark:text-slate-300">{timeBudget.station_buffer_min}分钟</p>
          </div>
          <div>
            <span className="text-slate-400 dark:text-slate-500">最晚出发</span>
            <p className="font-semibold text-red-600 dark:text-red-400">{timeBudget.latest_leave_for_station}</p>
          </div>
        </div>
        {timeBudget.buffer_reason && (
          <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-start gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1 shrink-0" />
            <span className="leading-snug">{timeBudget.buffer_reason}</span>
          </div>
        )}
        {timeBudget.rush_hour_detected && (
          <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            已考虑晚高峰影响，通勤时间已自动调整
          </div>
        )}
      </div>
    </div>
  );
}
