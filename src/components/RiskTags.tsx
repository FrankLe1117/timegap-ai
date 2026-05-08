import { SuitabilityTags } from "@/types";

const TONE = {
  good: "text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60",
  warn: "text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/60",
  bad: "text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60",
  info: "text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900/60",
  muted: "text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700",
  mutedSoft: "text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700",
};

const tagConfig: Record<string, Record<string, { label: string; classes: string }>> = {
  time_safety: {
    High: { label: "时间安全", classes: TONE.good },
    Medium: { label: "时间安全", classes: TONE.warn },
    Low: { label: "时间安全", classes: TONE.bad },
  },
  rush_hour_exposure: {
    Low: { label: "晚高峰风险", classes: TONE.good },
    Medium: { label: "晚高峰风险", classes: TONE.warn },
    High: { label: "晚高峰风险", classes: TONE.bad },
  },
  walking_intensity: {
    Low: { label: "步行强度", classes: TONE.good },
    Medium: { label: "步行强度", classes: TONE.warn },
    High: { label: "步行强度", classes: TONE.bad },
  },
  local_experience: {
    High: { label: "本地体验", classes: TONE.info },
    Medium: { label: "本地体验", classes: TONE.muted },
    Low: { label: "本地体验", classes: TONE.mutedSoft },
  },
  luggage_friendly: {
    High: { label: "行李友好", classes: TONE.good },
    Medium: { label: "行李友好", classes: TONE.warn },
    Low: { label: "行李友好", classes: TONE.bad },
  },
  weather_robustness: {
    High: { label: "天气适应", classes: TONE.good },
    Medium: { label: "天气适应", classes: TONE.warn },
    Low: { label: "天气适应", classes: TONE.bad },
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
            <span key={key} className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${config.classes}`}>
              <span className="font-normal opacity-70">{config.label}</span>
              <span>{value as string}</span>
            </span>
          );
        })}
      {tags.station_arrival_confidence !== undefined && (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${
          tags.station_arrival_confidence >= 85
            ? TONE.good
            : tags.station_arrival_confidence >= 65
              ? TONE.warn
              : TONE.bad
        }`}>
          <span className="font-normal opacity-70">到站信心</span>
          <span>{tags.station_arrival_confidence}%</span>
        </span>
      )}
    </div>
  );
}
