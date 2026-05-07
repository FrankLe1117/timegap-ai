"use client";

import { useRef, useState } from "react";
import { Plan, RouteHop } from "@/types";
import TimelineItem from "./TimelineItem";
import { exportPlanNodeToPng } from "@/lib/plan-export";

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
    bestFor: "适合大多数最后一天",
    accentBg: "bg-blue-50",
    accentBorder: "border-blue-200",
    accentText: "text-blue-700",
    dotColor: "bg-blue-500",
    icon: "🧭",
  },
  low_risk: {
    label: "稳妥赶车路线",
    bestFor: "带行李或时间紧",
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

function MiniBar({ value, label, kind }: { value: number; label: string; kind: "safety" | "experience" }) {
  const safetyColor = value >= 85 ? "bg-emerald-500" : value >= 65 ? "bg-amber-500" : "bg-red-500";
  const safetyText = value >= 85 ? "text-emerald-600" : value >= 65 ? "text-amber-600" : "text-red-600";
  const expColor = value >= 75 ? "bg-purple-500" : value >= 55 ? "bg-blue-500" : "bg-slate-400";
  const expText = value >= 75 ? "text-purple-600" : value >= 55 ? "text-blue-600" : "text-slate-500";
  const color = kind === "safety" ? safetyColor : expColor;
  const textColor = kind === "safety" ? safetyText : expText;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-slate-400">{label}</span>
      <div className="w-12 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-[11px] font-mono font-semibold ${textColor}`}>{value}</span>
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

function RouteChainView({ chain, dotColor, compact }: { chain: RouteHop[]; dotColor: string; compact?: boolean }) {
  if (!chain || chain.length === 0) return null;
  const stops = chain.filter((h) => h.kind === "stop");
  const legs = chain.filter((h) => h.kind === "leg");
  const seq: { name: string; legBefore?: RouteHop }[] = [];
  if (legs[0]) seq.push({ name: legs[0].from });
  let legIdx = 0;
  for (const stop of stops) {
    const leg = legs[legIdx];
    legIdx++;
    seq.push({ name: stop.from, legBefore: leg });
  }
  const finalLeg = legs[legIdx];
  if (finalLeg) seq.push({ name: finalLeg.to, legBefore: finalLeg });

  if (seq.length === 0) return null;

  return (
    <div className={`flex items-center flex-wrap gap-y-1 ${compact ? "text-[10px]" : "text-[11px]"}`}>
      {seq.map((node, idx) => (
        <span key={idx} className="inline-flex items-center">
          {node.legBefore && (
            <span className="inline-flex items-center text-slate-400 mx-1">
              <span className={`mr-0.5 ${node.legBefore.is_rush_hour ? "text-amber-500" : ""}`}>
                ─{node.legBefore.travel_min}m{node.legBefore.is_rush_hour ? "⚠" : ""}─
              </span>
              <span>›</span>
            </span>
          )}
          <span className="inline-flex items-center text-slate-700">
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor} mr-1`} />
            <span className="font-medium">{node.name}</span>
          </span>
        </span>
      ))}
    </div>
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

  const exportRootRef = useRef<HTMLDivElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const handleExport = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!exportRootRef.current || exporting) return;
    setExporting(true);
    setExportMsg(null);
    const result = await exportPlanNodeToPng(exportRootRef.current, { plan });
    setExporting(false);
    if (result.ok) {
      setExportMsg({ kind: "ok", text: `已保存 ${result.filename}` });
    } else {
      setExportMsg({ kind: "err", text: `保存失败：${result.error}` });
    }
    setTimeout(() => setExportMsg(null), 4000);
  };

  return (
    <div
      className={`rounded-xl border transition-all cursor-pointer ${
        selected
          ? `${meta.accentBorder} shadow-md ring-1 ring-slate-200/50`
          : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
      }`}
      onClick={onSelect}
    >
      {/* exportRoot wraps everything we want in the snapshot. */}
      <div ref={exportRootRef} className="bg-white rounded-xl">
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
            <div className="flex items-center gap-1 text-[11px] text-slate-500" data-export-ignore="true">
              <span>{stopCount}站</span>
              <svg
                className={`w-3.5 h-3.5 transition-transform ${selected ? "rotate-180" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>

          {/* Trade-off one-line */}
          {!selected && plan.tradeoff_summary && (
            <p className={`text-xs ${meta.accentText} mb-2 leading-snug line-clamp-2`}>
              {plan.tradeoff_summary}
            </p>
          )}

          {/* Route chain */}
          {!selected && plan.route_chain && plan.route_chain.length > 0 && (
            <div className="mb-2">
              <RouteChainView chain={plan.route_chain} dotColor={meta.dotColor} compact />
            </div>
          )}

          {/* Dual metrics */}
          <div className="flex items-center gap-3 flex-wrap">
            <MiniBar value={tags.station_arrival_confidence} label="到站安全" kind="safety" />
            <MiniBar value={tags.experience_score} label="体验分" kind="experience" />
            <Badge label="步行" value={tags.walking_intensity} good={tags.walking_intensity === "Low"} />
            <Badge label="高峰" value={tags.rush_hour_exposure} good={tags.rush_hour_exposure === "Low"} />
          </div>

          {!selected && (
            <div className="mt-2 pt-2 border-t border-slate-50 flex items-center justify-between" data-export-ignore="true">
              <p className="text-[11px] text-slate-500">最晚出发去车站 <span className="font-mono text-red-600 font-semibold">{plan.latest_leave_for_station}</span></p>
              <p className="text-[11px] text-blue-600 font-medium">查看详情 →</p>
            </div>
          )}
        </div>

        {/* Expanded detail — only when selected */}
        {selected && (
          <div className="border-t border-slate-100" onClick={(e) => e.stopPropagation()}>
            {/* Time window line — useful for export readers */}
            <div className="px-4 py-2 border-b border-slate-100 text-[11px] text-slate-500 flex items-center gap-3">
              <span>
                时间窗 <span className="font-mono text-slate-700">
                  {plan.timeline[0]?.start_time}–{plan.timeline[plan.timeline.length - 1]?.end_time}
                </span>
              </span>
              <span>
                最晚出发 <span className="font-mono text-red-600 font-semibold">{plan.latest_leave_for_station}</span>
              </span>
            </div>

            {/* Trade-off + explanation */}
            <div className="px-4 py-3 bg-slate-50/50 space-y-2">
              <div>
                <p className="text-[11px] font-medium text-slate-500 mb-1">取舍说明</p>
                <p className={`text-xs font-medium ${meta.accentText}`}>{plan.tradeoff_summary}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium text-slate-500 mb-1">为什么这样安排</p>
                <p className="text-xs text-slate-600 leading-relaxed">{plan.explanation}</p>
              </div>
            </div>

            {/* Route chain visualization */}
            {plan.route_chain && plan.route_chain.length > 0 && (
              <div className="px-4 py-3 border-t border-slate-100">
                <p className="text-[11px] font-medium text-slate-500 mb-2">空间-时间链路</p>
                <RouteChainView chain={plan.route_chain} dotColor={meta.dotColor} />
                <p className="text-[10px] text-slate-400 mt-1">数字 = 段间分钟数，⚠ = 处于晚高峰</p>
              </div>
            )}

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

            {/* Export-only notice. Visible in the saved PNG so the reader
                knows the embedded Amap links cannot be tapped. */}
            <div className="px-4 py-2 bg-amber-50/70 border-t border-amber-100 text-[11px] text-amber-700 flex items-start gap-1.5">
              <span>📷</span>
              <span>
                图片中的地图/高德链接无法点击，请回到 TimeGap AI 应用内打开路线。
                生成时间：{new Date().toLocaleString("zh-CN", { hour12: false })}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Save-image action bar — sits OUTSIDE exportRootRef so it doesn't
          render in the saved PNG. */}
      {selected && (
        <div
          className="border-t border-slate-100 px-4 py-2.5 flex items-center justify-between gap-3 bg-white rounded-b-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5 leading-snug">
            <span>💡</span>
            <span>保存为图片后，地图链接不可点击。如需打开路线，请回到应用内。</span>
          </div>
          <div className="flex items-center gap-2">
            {exportMsg && (
              <span
                className={`text-[11px] ${
                  exportMsg.kind === "ok" ? "text-emerald-600" : "text-red-600"
                }`}
              >
                {exportMsg.text}
              </span>
            )}
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              title="将该方案保存为本地 PNG 图片（链接不可点击）"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 text-xs font-medium text-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
              </svg>
              {exporting ? "保存中…" : "保存图片"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
