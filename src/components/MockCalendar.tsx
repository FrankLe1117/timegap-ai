import { CalendarEvent, FreeWindow } from "@/types";
import calendarData from "@/data/sample_calendar.json";

const { calendar_events, free_windows } = calendarData as {
  calendar_events: CalendarEvent[];
  free_windows: FreeWindow[];
};

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}h${m}m`;
}

export default function MockCalendar({ onSelectWindow }: { onSelectWindow: (window: FreeWindow) => void }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-100">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-700">今日日程（演示数据）</h3>
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
            模拟日历
          </span>
        </div>
      </div>

      <div className="px-4 py-2.5 space-y-2">
        {calendar_events.map((evt) => (
          <div key={evt.id} className="flex items-center gap-3">
            <div className="w-0.5 h-7 bg-blue-400 rounded-full shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-slate-800 truncate">{evt.title}</p>
              <p className="text-[11px] text-slate-500">{evt.start_time}–{evt.end_time} · {evt.location}</p>
            </div>
          </div>
        ))}
      </div>

      {free_windows.length > 0 && (
        <div className="px-4 py-2.5 bg-emerald-50/40 border-t border-emerald-100">
          <p className="text-[11px] font-medium text-emerald-700 mb-1.5">
            从你的日程中发现了空闲时段
          </p>
          {free_windows.map((w, i) => (
            <button
              key={i}
              onClick={() => onSelectWindow(w)}
              className="w-full text-left px-3 py-2.5 bg-white rounded-lg border border-emerald-200 hover:border-emerald-300 hover:shadow-sm transition-all mb-1.5 last:mb-0"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-emerald-800">
                  {w.start_time}–{w.end_time} · {formatDuration(w.duration_min)}可用
                </span>
                <span className="text-[11px] text-emerald-600 font-medium">规划此时段 →</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
