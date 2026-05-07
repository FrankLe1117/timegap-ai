import { Plan } from "@/types";
import TimelineItem from "./TimelineItem";

const planMeta: Record<string, {
  label: string;
  bestFor: string;
  accentBg: string;
  accentBorder: string;
  accentText: string;
  dotColor: string;
  icon: string;
}> = {
  balanced: {
    label: "均衡本地路线",
    bestFor: "适合大多数出行者",
    accentBg: "bg-blue-50",
    accentBorder: "border-blue-200",
    accentText: "text-blue-700",
    dotColor: "bg-blue-500",
    icon: "🧭",
  },
  low_risk: {
    label: "稳妥车站路线",
    bestFor: "赶时间或带行李",
    accentBg: "bg-emerald-50",
    accentBorder: "border-emerald-200",
    accentText: "text-emerald-700",
    dotColor: "bg-emerald-500",
    icon: "🛡️",
  },
  local_experience: {
    label: "深度本地体验",
    bestFor: "想感受城市气息",
    accentBg: "bg-purple-50",
    accentBorder: "border-purple-200",
    accentText: "text-purple-700",
    dotColor: "bg-purple-500",
    icon: "🏙️",
  },
};

function MiniConfidence({ value }: { value: number }) {
  const color = value >= 85 ? "bg-emerald-500" : value >= 65 ? "bg-amber-500" : "bg-red-500";
  const textColor = value >= 85 ? "text-emerald-600" : value >= 65 ? "text-amber-600" : "text-red-600";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-[11px] font-mono font-semibold ${textColor}`}>{value}%</span>
    </div>
  );
}

function Badge({ label, value, good }: { label: string; value: string; good: boolean }) {
  const color = good
    ? "text-emerald-700 bg-emerald-50 border-emerald-100"
    : "text-amber-700 bg-amber-50 border-amber-100";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] border ${color}`}>
      {label} {value}
    </span>
  );
}

interface PlanCardProps {
  plan: Plan;
  selected: boolean;
  onSelect: () => void;
}

export default function PlanCard({ plan, selected, onSelect }: PlanCardProps) {
  const meta = planMeta[plan.plan_type] || planMeta.balanced;
  const stopCount = plan.timeline.filter(
    (t) => !["transport", "station_buffer"].includes(t.activity_type)
  ).length;
  const tags = plan.suitability_tags;

  return (
    <div
      className={`rounded-xl border transition-all cursor-pointer ${
        selected
          ? `${meta.accentBorder} shadow-md ring-1 ring-slate-200/50`
          : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
      }`}
      onClick={onSelect}
    >
      {/* Compact card — always visible */}
      <div className="px-4 py-3">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm">{meta.icon}</span>
            <div>
              <span className="text-sm font-semibold text-slate-900">{meta.label}</span>
              <span className="ml-2 text-[11px] text-slate-400">{meta.bestFor}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-slate-500">
            <span>{stopCount}站</span>
            <svg
              className={`w-3.5 h-3.5 transition-transform ${selected ? "rotate-180" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>

        {/* Distinctive one-line highlight to make the three options easy to compare */}
        {!selected && plan.one_sentence_summary && (
          <p className={`text-xs ${meta.accentText} bg-white/0 mb-2 leading-snug line-clamp-2`}>
            {plan.one_sentence_summary}
          </p>
        )}

        {/* Highlight stops chips for quick comparison */}
        {!selected && (
          <div className="flex items-center gap-1 flex-wrap mb-2">
            {plan.timeline
              .filter((t) => !["transport", "station_buffer"].includes(t.activity_type))
              .slice(0, 4)
              .map((t, i, arr) => (
                <span key={i} className="inline-flex items-center text-[11px] text-slate-600">
                  <span className={`w-1 h-1 rounded-full ${meta.dotColor} mr-1`} />
                  {t.place_name}
                  {i < arr.length - 1 && <span className="mx-1 text-slate-300">›</span>}
                </span>
              ))}
          </div>
        )}

        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-400">到站信心</span>
            <MiniConfidence value={tags.station_arrival_confidence} />
          </div>
          <Badge label="步行量" value={tags.walking_intensity} good={tags.walking_intensity === "Low"} />
          <Badge label="高峰影响" value={tags.rush_hour_exposure} good={tags.rush_hour_exposure === "Low"} />
          <span className="text-[11px] text-slate-400">{stopCount}个停留点</span>
        </div>

        {!selected && (
          <div className="mt-2 pt-2 border-t border-slate-50 flex items-center justify-between">
            <p className="text-[11px] text-slate-500">最晚出发去车站 <span className="font-mono text-red-600 font-semibold">{plan.latest_leave_for_station}</span></p>
            <p className="text-[11px] text-blue-600 font-medium">查看详情 →</p>
          </div>
        )}
      </div>

      {/* Expanded detail — only when selected */}
      {selected && (
        <div className="border-t border-slate-100" onClick={(e) => e.stopPropagation()}>
          {/* Why this plan works */}
          <div className="px-4 py-3 bg-slate-50/50">
            <p className="text-[11px] font-medium text-slate-500 mb-1">为什么推荐这个方案</p>
            <p className="text-xs text-slate-600 leading-relaxed">{plan.explanation}</p>
          </div>

          {/* Rush hour warning */}
          {plan.rush_hour_warning && (
            <div className="px-4 py-2 bg-amber-50 border-y border-amber-100 text-xs text-amber-700 flex items-center gap-1.5">
              <span>⚠️</span>
              {plan.rush_hour_warning}
            </div>
          )}

          {/* Timeline */}
          <div className="px-4 py-3">
            <p className="text-[11px] font-medium text-slate-500 mb-2">时间线</p>
            <div className="space-y-0">
              {plan.timeline.map((item, i) => (
                <TimelineItem
                  key={i}
                  item={item}
                  isLast={i === plan.timeline.length - 1}
                />
              ))}
            </div>
          </div>

          {/* Footer: risk + departure */}
          <div className="px-4 py-3 bg-slate-50/50 border-t border-slate-100 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">建议最晚出发去车站</span>
              <span className="font-semibold text-red-600">{plan.latest_leave_for_station}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span>📌</span>
              <span>{plan.risk_note}</span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <span>💡</span>
              <span>{plan.backup_suggestion}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
