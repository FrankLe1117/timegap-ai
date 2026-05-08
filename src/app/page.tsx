"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import ChatPanel from "@/components/ChatPanel";
import ItineraryBoard from "@/components/ItineraryBoard";
import TripConstraintsPanel from "@/components/TripConstraintsPanel";
import ThemeToggle from "@/components/ThemeToggle";
import { PlanResponse, Plan, ParseResult } from "@/types";

const SESSION_KEY = "laststop:state:v1";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface PersistedState {
  messages: Message[];
  planData: PlanResponse | null;
  previousPlans: Plan[] | undefined;
}

interface PendingClarification {
  originalInput: string;
  parseResult: ParseResult;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [planData, setPlanData] = useState<PlanResponse | null>(null);
  const [previousPlans, setPreviousPlans] = useState<Plan[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [showConstraintsPanel, setShowConstraintsPanel] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [pendingClarification, setPendingClarification] = useState<PendingClarification | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Abort in-flight request when a new one starts — prevents stale plans from
  // overwriting a fresher request. Crucial for live demo when the presenter
  // double-clicks or quickly iterates with quick-action chips.
  const abortRef = useRef<AbortController | null>(null);
  // Track the latest request id so a delayed response from an older request
  // never overwrites a newer one (defence in depth on top of AbortController).
  const requestIdRef = useRef(0);

  // Hydrate from sessionStorage on mount. Skipped on SSR (window check).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const s = JSON.parse(raw) as PersistedState;
        if (Array.isArray(s.messages)) setMessages(s.messages);
        if (s.planData) setPlanData(s.planData);
        if (s.previousPlans) setPreviousPlans(s.previousPlans);
      }
    } catch {
      // Corrupted state — clear it so a future load doesn't keep failing.
      try { window.sessionStorage.removeItem(SESSION_KEY); } catch {}
    }
    setHydrated(true);
  }, []);

  // Persist after every meaningful state change. We skip the very first render
  // before hydration so we don't blow away saved state with the empty defaults.
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    try {
      const payload: PersistedState = { messages, planData, previousPlans };
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      // Quota / private mode — silently ignore.
    }
  }, [hydrated, messages, planData, previousPlans]);

  const callPlanApi = useCallback(
    async (
      input: string,
      extraConstraints?: Record<string, unknown>,
      allowAssumptions?: boolean,
      effectiveInput?: string,
    ) => {
      // Cancel any in-flight request before kicking off a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRequestId = ++requestIdRef.current;

      setLoading(true);
      try {
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userInput: effectiveInput || input,
            currentConstraints: extraConstraints,
            previousPlans,
            allowAssumptions: allowAssumptions || false,
          }),
          signal: controller.signal,
        });

        // A newer request superseded us — don't write stale state.
        if (myRequestId !== requestIdRef.current) return;

        const data = await res.json();
        if (!res.ok) throw new Error("Plan generation failed");

        if (data && data.needsClarification) {
          const pr = data.parseResult as ParseResult;
          setPendingClarification({ originalInput: effectiveInput || input, parseResult: pr });
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: data.message as string },
          ]);
          return;
        }

        const planResponse = data as PlanResponse;
        setPlanData(planResponse);
        setPreviousPlans(planResponse.plans);
        setSelectedPlan(null);
        setPendingClarification(null);

        let msg = "";
        if (planResponse.replanChanges && planResponse.replanChanges.length > 0) {
          const removals = planResponse.replanChanges.filter((c) => c.action === "removed");
          const additions = planResponse.replanChanges.filter(
            (c) => c.action === "added" || c.action === "moved" || c.action === "replaced",
          );
          if (removals.length > 0) {
            msg = `已更新方案：${removals.map((r) => r.detail).join("；")}。`;
          } else {
            msg = "已根据你的要求重新规划。";
          }
          if (additions.length > 0) {
            msg += ` ${additions.map((a) => a.detail).join("；")}。`;
          }
        } else {
          const sourceTag =
            planResponse.parseMeta?.source === "llm" ? "（Perplexity 解析）" : "（规则解析）";
          msg = `找到了 ${planResponse.plans.length} 个可行方案${sourceTag}，已按你 ${planResponse.parsedConstraints.departure_time} 的车次做了安全检查。`;
          if (planResponse.timeBudget.rush_hour_detected) {
            msg += " 已考虑晚高峰影响，通勤时间已自动调整。";
          }
          if (allowAssumptions && planResponse.parseMeta?.assumptions?.length) {
            msg += ` 使用了默认值：${planResponse.parseMeta.assumptions.join("；")}。`;
          }
        }

        setMessages((prev) => [...prev, { role: "assistant", content: msg }]);
      } catch (err) {
        // Aborted requests are expected (user typed faster than network) —
        // don't surface them as errors.
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (myRequestId !== requestIdRef.current) return;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "规划遇到了问题，请重试。" },
        ]);
      } finally {
        if (myRequestId === requestIdRef.current) setLoading(false);
      }
    },
    [previousPlans],
  );

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setPlanData(null);
    setPreviousPlans(undefined);
    setSelectedPlan(null);
    setPendingClarification(null);
    if (typeof window !== "undefined") {
      try { window.sessionStorage.removeItem(SESSION_KEY); } catch {}
    }
  }, []);

  const handlePlan = useCallback(
    async (input: string, extraConstraints?: Record<string, unknown>) => {
      setMessages((prev) => [...prev, { role: "user", content: input }]);

      // If we are awaiting clarification and the user replies "就按默认/直接规划/默认即可"
      if (pendingClarification && /默认|就这样|直接规划|按默认/.test(input)) {
        await callPlanApi(
          pendingClarification.originalInput,
          extraConstraints,
          true,
          pendingClarification.originalInput,
        );
        return;
      }

      // If awaiting clarification and the user gave more details, combine with original.
      const effectiveInput = pendingClarification
        ? `${pendingClarification.originalInput}。补充信息：${input}`
        : input;

      await callPlanApi(input, extraConstraints, false, effectiveInput);
    },
    [callPlanApi, pendingClarification],
  );

  const handleAcceptDefaults = useCallback(async () => {
    if (!pendingClarification) return;
    setMessages((prev) => [...prev, { role: "user", content: "就按默认规划" }]);
    await callPlanApi(pendingClarification.originalInput, undefined, true, pendingClarification.originalInput);
  }, [pendingClarification, callPlanApi]);

  const handleSelectPlan = useCallback((planType: string) => {
    setSelectedPlan((prev) => (prev === planType ? null : planType));
  }, []);

  const headerKpis = planData ? {
    safety: Math.max(...planData.plans.map((p) => p.suitability_tags.station_arrival_confidence)),
    experience: Math.max(...planData.plans.map((p) => p.suitability_tags.experience_score)),
  } : null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header bar */}
      <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 py-2.5 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-sm shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Last Stop 尾程</span>
                <span className="hidden sm:inline text-[11px] text-slate-400 dark:text-slate-500 truncate">赶在起飞之前，再多玩一会</span>
              </div>
              {headerKpis && (
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    到站安全 <span className={`font-mono font-semibold ${headerKpis.safety >= 85 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>{headerKpis.safety}</span>
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    体验分 <span className={`font-mono font-semibold ${headerKpis.experience >= 75 ? "text-purple-600 dark:text-purple-400" : "text-blue-600 dark:text-blue-400"}`}>{headerKpis.experience}</span>
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {planData && (
              <button
                type="button"
                onClick={handleReset}
                title="开始新会话"
                aria-label="开始新会话"
                className="hidden sm:inline-flex items-center gap-1 px-2 py-1 text-[11px] text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                重新开始
              </button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="max-w-7xl mx-auto p-3 sm:p-4 lg:p-6">
        <div
          className="grid grid-cols-1 lg:grid-cols-5 gap-3 sm:gap-4 lg:gap-6"
          style={{ minHeight: "calc(100dvh - 80px)" }}
        >
          <div className="lg:col-span-2 flex flex-col gap-3 min-h-[500px] lg:min-h-[calc(100dvh-110px)]">
            <div className="flex-1 min-h-0">
              <ChatPanel
                onPlan={handlePlan}
                loading={loading}
                messages={messages}
                clarification={
                  pendingClarification
                    ? {
                        missing: pendingClarification.parseResult.missing,
                        assumptions: pendingClarification.parseResult.assumptions,
                        onAcceptDefaults: handleAcceptDefaults,
                      }
                    : null
                }
              />
            </div>
            {showConstraintsPanel ? (
              <div className="shrink-0">
                <TripConstraintsPanel
                  data={planData}
                  onClose={() => setShowConstraintsPanel(false)}
                />
              </div>
            ) : (
              <button
                onClick={() => setShowConstraintsPanel(true)}
                className="shrink-0 w-full text-xs px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-300 dark:hover:border-blue-700 hover:text-blue-700 dark:hover:text-blue-400 text-slate-600 dark:text-slate-400 rounded-xl transition-colors flex items-center justify-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                展开尾程约束
              </button>
            )}
          </div>

          <div className="lg:col-span-3 min-h-[500px] lg:min-h-[calc(100dvh-110px)]">
            <ItineraryBoard
              data={planData}
              selectedPlan={selectedPlan}
              onSelectPlan={handleSelectPlan}
              loading={loading}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
