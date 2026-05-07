import { PlanResponse } from "@/types";
import ParsedConstraintsCard from "./ParsedConstraintsCard";
import PlanCard from "./PlanCard";
import PlanComparisonTable from "./PlanComparisonTable";
import ReplanChanges from "./ReplanChanges";

interface Props {
  data: PlanResponse | null;
  selectedPlan: string | null;
  onSelectPlan: (planType: string) => void;
}

function DataSourceIndicator({ data }: { data: PlanResponse }) {
  const ds = data.dataSources;
  if (!ds) return null;
  const rs = ds.routesSource;
  let label = "演示城市图 · 规则兜底";
  let dotClass = "bg-purple-400";
  if (rs === "amap") {
    label = "高德路线估算 · 实时 POI/地理编码";
    dotClass = "bg-emerald-500";
  } else if (rs === "mixed") {
    label = "高德路线（部分） + 演示城市图回退";
    dotClass = "bg-amber-400";
  } else if (!ds.amapConfigured) {
    label = "演示城市图（未配置 AMAP_API_KEY）";
  }
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-4 py-2 flex items-center gap-2 text-[11px] text-slate-500">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span className="font-medium text-slate-600">数据来源</span>
      <span>{label}</span>
      <span className="ml-auto text-slate-400">{ds.travelTimes}</span>
    </div>
  );
}

export default function ItineraryBoard({ data, selectedPlan, onSelectPlan }: Props) {
  if (!data) {
    return (
      <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-slate-400 px-8">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
            <p className="text-sm">方案将在这里呈现</p>
            <p className="text-xs mt-1 text-slate-300">点击「规划此时段」或输入你的需求</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {/* Constraint summary + time budget */}
        <ParsedConstraintsCard constraints={data.parsedConstraints} timeBudget={data.timeBudget} />

        {/* Data source indicator */}
        <DataSourceIndicator data={data} />

        {/* Replan changes if any */}
        {data.replanChanges && <ReplanChanges changes={data.replanChanges} />}

        {/* Plan cards — compact by default, expandable */}
        <div className="space-y-2">
          {data.plans.map((plan) => (
            <PlanCard
              key={plan.plan_type}
              plan={plan}
              selected={selectedPlan === plan.plan_type}
              onSelect={() => onSelectPlan(plan.plan_type)}
            />
          ))}
        </div>

        {/* Comparison table — show when a plan is selected */}
        {selectedPlan && (
          <PlanComparisonTable plans={data.plans} />
        )}
      </div>
    </div>
  );
}
