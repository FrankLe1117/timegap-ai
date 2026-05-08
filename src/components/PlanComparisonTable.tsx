import { Plan } from "@/types";

function MiniBar({ value, kind }: { value: number; kind: "safety" | "experience" }) {
  const safetyColor = value >= 85 ? "bg-emerald-500" : value >= 65 ? "bg-amber-500" : "bg-red-500";
  const expColor = value >= 75 ? "bg-purple-500" : value >= 55 ? "bg-blue-500" : "bg-slate-400";
  const color = kind === "safety" ? safetyColor : expColor;
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-10 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[11px] font-mono text-slate-600 dark:text-slate-300">{value}</span>
    </div>
  );
}

function Dot({ good }: { good: boolean }) {
  return (
    <span className={`w-1.5 h-1.5 rounded-full ${good ? "bg-emerald-500" : "bg-amber-400"}`} />
  );
}

const labels: Record<string, { key: string; label: string; invert: boolean }> = {
  time_safety: { key: "time_safety", label: "时间宽裕度", invert: false },
  rush_hour: { key: "rush_hour_exposure", label: "高峰影响", invert: true },
  walking: { key: "walking_intensity", label: "步行量", invert: true },
  local: { key: "local_experience", label: "本地体验", invert: false },
};

const planLabels: Record<string, string> = {
  balanced: "均衡路线",
  low_risk: "稳妥路线",
  local_experience: "深度体验",
};

export default function PlanComparisonTable({ plans }: { plans: Plan[] }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">方案对比</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-slate-50 dark:border-slate-800">
              <th className="text-left px-3 py-2 text-slate-400 dark:text-slate-500 font-normal" />
              {plans.map((p) => (
                <th key={p.plan_type} className="text-center px-3 py-2 font-medium text-slate-600 dark:text-slate-300">
                  {planLabels[p.plan_type] || p.plan_name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.values(labels).map(({ key, label, invert }) => (
              <tr key={key} className="border-b border-slate-50 dark:border-slate-800">
                <td className="px-3 py-1.5 text-slate-500 dark:text-slate-400">{label}</td>
                {plans.map((p) => {
                  const rawVal = p.suitability_tags[key as keyof typeof p.suitability_tags];
                  const val = typeof rawVal === "string" ? rawVal : String(rawVal);
                  const good = invert ? val === "低" || val === "Low" : val === "高" || val === "High";
                  const displayVal = val === "High" ? "高" : val === "Low" ? "低" : val === "Medium" ? "中" : val;
                  return (
                    <td key={p.plan_type} className="text-center px-3 py-1.5">
                      <span className="inline-flex items-center gap-1">
                        <Dot good={good} />
                        <span className="text-slate-600 dark:text-slate-300">{displayVal}</span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td className="px-3 py-1.5 text-slate-500 dark:text-slate-400 font-medium">到站安全</td>
              {plans.map((p) => (
                <td key={p.plan_type} className="px-3 py-1.5">
                  <MiniBar value={p.suitability_tags.station_arrival_confidence} kind="safety" />
                </td>
              ))}
            </tr>
            <tr>
              <td className="px-3 py-1.5 text-slate-500 dark:text-slate-400 font-medium">体验分</td>
              {plans.map((p) => (
                <td key={p.plan_type} className="px-3 py-1.5">
                  <MiniBar value={p.suitability_tags.experience_score} kind="experience" />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
