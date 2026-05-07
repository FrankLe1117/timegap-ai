"use client";

import { useState, useRef, useEffect } from "react";
import LastDayModePanel from "./LastDayModePanel";

const EXAMPLE_PROMPTS = [
  "出差最后一天，11:30 在陆家嘴开完会，22:00 虹桥站高铁返程。想吃本地菜再轻度逛逛。",
  "下午 2 点在三里屯结束事情，晚上 8 点首都机场起飞。带行李，不想走太多路。",
  "成都最后一天，下午 1 点从春熙路出发，晚上 9 点成都东站发车。下雨，找室内为主。",
  "广州出差，中午 12 点在珠江新城收尾，晚上 10 点白云机场起飞。想体验更本地，但绝对不能误车。",
];

const QUICK_ACTIONS = [
  { label: "带了行李", constraint: { luggage: true }, message: "我带了行李" },
  { label: "下雨了", constraint: { weather: "rainy" as const }, message: "下雨了" },
  { label: "少走路", constraint: { walking_preference: "low" as const }, message: "少走路" },
  { label: "更本地", constraint: { preferences: ["local_food", "local_experience"] }, message: "更本地一点" },
  { label: "¥200以内", constraint: { budget_per_person: 200 }, message: "预算200以内" },
  { label: "早点到站", constraint: {}, message: "我想早点到站" },
  { label: "加个咖啡", constraint: { preferences: ["coffee"] }, message: "加一个咖啡馆" },
  { label: "避开游客", constraint: { constraints: ["avoid_tourist"] }, message: "不想去游客多的地方" },
];

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ClarificationPrompt {
  missing: string[];
  assumptions: string[];
  onAcceptDefaults: () => void;
}

interface ChatPanelProps {
  onPlan: (input: string, constraints?: Record<string, unknown>) => void;
  loading: boolean;
  messages: Message[];
  clarification?: ClarificationPrompt | null;
}

const FIELD_LABELS_ZH: Record<string, string> = {
  start_location: "起点",
  final_destination: "终点",
  start_time: "空闲开始时间",
  departure_time: "出发车次时间",
};

export default function ChatPanel({ onPlan, loading, messages, clarification }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [showExamples, setShowExamples] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (text?: string) => {
    const value = text || input;
    if (!value.trim() || loading) return;
    onPlan(value);
    setInput("");
    setShowExamples(false);
  };

  const handleQuickAction = (action: (typeof QUICK_ACTIONS)[number]) => {
    onPlan(action.message, action.constraint);
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl shadow-sm border border-slate-200">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-semibold text-slate-900">Last Stop 尾程</h1>
            <p className="text-[11px] text-slate-400">离城前的最后几小时，安排得刚刚好。</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-6 text-slate-500">
            <svg className="w-10 h-10 mx-auto mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p className="text-sm text-slate-600">告诉我你的起点、出发车次／航班和偏好</p>
            <p className="text-[11px] mt-1 text-slate-400">支持国内多数城市，在「赶车安全边界」内给你最优体验</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-blue-600 text-white rounded-br-md"
                  : "bg-slate-100 text-slate-700 rounded-bl-md"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-100 px-4 py-3 rounded-2xl rounded-bl-md">
              <div className="flex gap-1.5">
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Structured planner panel — shown before any chat */}
      {messages.length === 0 && (
        <div className="px-6 pb-2">
          <LastDayModePanel
            onSubmit={(input) => {
              onPlan(input);
              setShowExamples(false);
            }}
            loading={loading}
          />
        </div>
      )}

      {/* Clarification prompt — shown when parser confidence is low */}
      {clarification && (
        <div className="mx-6 mb-3 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-800">
          <p className="font-medium mb-1.5">需要确认这些信息：</p>
          <ul className="list-disc list-inside space-y-0.5 mb-2">
            {clarification.missing.map((m) => (
              <li key={m}>{FIELD_LABELS_ZH[m] || m}</li>
            ))}
          </ul>
          {clarification.assumptions.length > 0 && (
            <p className="text-[11px] text-amber-700/80 mb-2">
              如果不补充，将使用默认：{clarification.assumptions.join("；")}。
            </p>
          )}
          <button
            onClick={clarification.onAcceptDefaults}
            disabled={loading}
            className="text-[11px] px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-full disabled:opacity-50"
          >
            就按默认规划
          </button>
          <span className="ml-2 text-[11px] text-amber-700/80">或在下方补充信息</span>
        </div>
      )}

      {/* Quick Actions */}
      {messages.length > 0 && (
        <div className="px-6 pb-3">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((action, i) => (
              <button
                key={i}
                onClick={() => handleQuickAction(action)}
                disabled={loading}
                className="text-xs px-3 py-1.5 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded-full transition-colors text-slate-600 hover:text-blue-700 disabled:opacity-50"
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input — prominent composer */}
      <div className="px-6 pb-4 pt-3">
        {messages.length === 0 && (
          <p className="text-[11px] text-slate-500 mb-1.5">或者直接用一句话描述：</p>
        )}
        <div className="relative rounded-2xl border-2 border-slate-200 bg-white shadow-sm focus-within:border-blue-500 focus-within:shadow-md transition-all">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={
              messages.length === 0
                ? "例：下午 2 点在三里屯结束事情，晚上 8 点首都机场起飞，带行李……"
                : "继续补充：再加一个咖啡馆 / 想换个本地小馆 / 改成更安全……"
            }
            rows={messages.length === 0 ? 3 : 2}
            className="w-full px-4 pt-3 pb-10 bg-transparent rounded-2xl text-sm leading-relaxed resize-none focus:outline-none placeholder:text-slate-400"
            disabled={loading}
          />
          <button
            onClick={() => handleSubmit()}
            disabled={loading || !input.trim()}
            className="absolute right-2 bottom-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-xs font-medium"
            aria-label="生成方案"
          >
            <span>生成</span>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </button>
        </div>

        {/* Example chips — secondary, compact */}
        {showExamples && messages.length === 0 && (
          <div className="mt-3">
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1.5">快速示例</p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLE_PROMPTS.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setInput(ex);
                  }}
                  title={ex}
                  className="text-[11px] px-2.5 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded-full transition-colors text-slate-500 hover:text-blue-700 max-w-full truncate"
                >
                  {ex.length > 26 ? ex.slice(0, 26) + "…" : ex}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
