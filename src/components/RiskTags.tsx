import { SuitabilityTags } from "@/types";

const tagConfig: Record<string, Record<string, { label: string; color: string; bg: string }>> = {
  time_safety: {
    High: { label: "时间安全", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
    Medium: { label: "时间安全", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
    Low: { label: "时间安全", color: "text-red-700", bg: "bg-red-50 border-red-200" },
  },
  rush_hour_exposure: {
    Low: { label: "晚高峰风险", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
    Medium: { label: "晚高峰风险", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
    High: { label: "晚高峰风险", color: "text-red-700", bg: "bg-red-50 border-red-200" },
  },
  walking_intensity: {
    Low: { label: "步行强度", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
    Medium: { label: "步行强度", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
    High: { label: "步行强度", color: "text-red-700", bg: "bg-red-50 border-red-200" },
  },
  local_experience: {
    High: { label: "本地体验", color: "text-blue-700", bg: "bg-blue-50 border-blue-200" },
    Medium: { label: "本地体验", color: "text-slate-700", bg: "bg-slate-50 border-slate-200" },
    Low: { label: "本地体验", color: "text-slate-500", bg: "bg-slate-50 border-slate-200" },
  },
  luggage_friendly: {
    High: { label: "行李友好", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
    Medium: { label: "行李友好", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
    Low: { label: "行李友好", color: "text-red-700", bg: "bg-red-50 border-red-200" },
  },
  weather_robustness: {
    High: { label: "天气适应", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
    Medium: { label: "天气适应", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
    Low: { label: "天气适应", color: "text-red-700", bg: "bg-red-50 border-red-200" },
  },
};

export default function RiskTags({ tags }: { tags: SuitabilityTags }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(tags)
        .filter(([key]) => key !== "station_arrival_confidence")
        .map(([key, value]) => {
          const config = tagConfig[key]?.[value as string];
          if (!config) return null;
          return (
            <span key={key} className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${config.bg} ${config.color}`}>
              <span className="font-normal opacity-70">{config.label}</span>
              <span>{value as string}</span>
            </span>
          );
        })}
      {tags.station_arrival_confidence !== undefined && (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${
          tags.station_arrival_confidence >= 85
            ? "bg-emerald-50 border-emerald-200 text-emerald-700"
            : tags.station_arrival_confidence >= 65
              ? "bg-amber-50 border-amber-200 text-amber-700"
              : "bg-red-50 border-red-200 text-red-700"
        }`}>
          <span className="font-normal opacity-70">到站信心</span>
          <span>{tags.station_arrival_confidence}%</span>
        </span>
      )}
    </div>
  );
}
