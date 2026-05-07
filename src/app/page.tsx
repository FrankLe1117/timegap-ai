"use client";

import { useState, useCallback } from "react";
import ChatPanel from "@/components/ChatPanel";
import ItineraryBoard from "@/components/ItineraryBoard";
import MockCalendar from "@/components/MockCalendar";
import { PlanResponse, Plan, FreeWindow } from "@/types";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [planData, setPlanData] = useState<PlanResponse | null>(null);
  const [previousPlans, setPreviousPlans] = useState<Plan[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [showCalendar, setShowCalendar] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);

  const handlePlan = useCallback(
    async (input: string, extraConstraints?: Record<string, unknown>) => {
      setMessages((prev) => [...prev, { role: "user", content: input }]);
      setLoading(true);

      try {
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userInput: input,
            currentConstraints: extraConstraints,
            previousPlans,
          }),
        });

        const data: PlanResponse = await res.json();
        if (!res.ok) throw new Error("Plan generation failed");

        setPlanData(data);
        setPreviousPlans(data.plans);
        setSelectedPlan(null);

        let msg = "";
        if (data.replanChanges && data.replanChanges.length > 0) {
          const removals = data.replanChanges.filter((c) => c.action === "removed");
          const additions = data.replanChanges.filter((c) => c.action === "added" || c.action === "moved" || c.action === "replaced");
          if (removals.length > 0) {
            msg = `已更新方案：${removals.map((r) => r.detail).join("；")}。`;
          } else {
            msg = "已根据你的要求重新规划。";
          }
          if (additions.length > 0) {
            msg += ` ${additions.map((a) => a.detail).join("；")}。`;
          }
        } else {
          msg = `找到了 ${data.plans.length} 个可行方案，已按你 ${data.parsedConstraints.departure_time} 的车次做了安全检查。`;
          if (data.timeBudget.rush_hour_detected) {
            msg += " 已考虑晚高峰影响，通勤时间已自动调整。";
          }
        }

        setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
      } catch {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "规划遇到了问题，请重试。" },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [previousPlans]
  );

  const handleCalendarSelect = useCallback(
    (window: FreeWindow) => {
      const input = `我今天${window.start_time}在陆家嘴结束会议，晚上22:00之后没有安排。帮我规划这段空闲时间。`;
      setShowCalendar(false);
      handlePlan(input);
    },
    [handlePlan]
  );

  const handleSelectPlan = useCallback((planType: string) => {
    setSelectedPlan((prev) => (prev === planType ? null : planType));
  }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header bar */}
      <div className="bg-white border-b border-slate-200 px-6 py-2.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <span className="text-sm font-semibold text-slate-900">TimeGap AI</span>
              {planData && (
                <span className="ml-2 text-xs text-slate-400">
                  到站信心{" "}
                  <span className={`font-semibold ${
                    Math.max(...planData.plans.map((p) => p.suitability_tags.station_arrival_confidence)) >= 85
                      ? "text-emerald-600"
                      : "text-amber-600"
                  }`}>
                    {Math.max(...planData.plans.map((p) => p.suitability_tags.station_arrival_confidence))}%
                  </span>
                </span>
              )}
            </div>
          </div>
          {planData && (
            <div className="flex items-center gap-3 text-[11px] text-slate-400">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                交通感知
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                到站安全已检查
              </span>
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                城市上下文
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-7xl mx-auto p-4 lg:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-6" style={{ height: "calc(100vh - 80px)" }}>
          <div className="lg:col-span-2 flex flex-col gap-3 min-h-[500px] lg:min-h-0">
            <div className="flex-1 min-h-0">
              <ChatPanel onPlan={handlePlan} loading={loading} messages={messages} />
            </div>
            {showCalendar && (
              <div className="shrink-0">
                <MockCalendar onSelectWindow={handleCalendarSelect} />
              </div>
            )}
          </div>

          <div className="lg:col-span-3 min-h-[500px] lg:min-h-0">
            <ItineraryBoard
              data={planData}
              selectedPlan={selectedPlan}
              onSelectPlan={handleSelectPlan}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
