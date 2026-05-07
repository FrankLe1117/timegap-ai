"use client";

import { useState, useRef, useEffect } from "react";

const EXAMPLE_PROMPTS = [
  "我今天上午11:30在陆家嘴开完会，晚上22:00从虹桥站坐高铁离开。中间想逛逛，吃顿有本地特色但不太贵的饭。",
  "我下午2点在人民广场结束事情，晚上8点半要到虹桥站。带着行李，不想走太多路。",
  "我今天下午1点从静安寺出发，晚上9点从虹桥站出发。今天下雨，想找室内的地方逛逛。",
  "我中午12点在陆家嘴结束会议，晚上10点从虹桥站走。想体验更本地的上海。",
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

interface ChatPanelProps {
  onPlan: (input: string, constraints?: Record<string, unknown>) => void;
  loading: boolean;
  messages: Message[];
}

export default function ChatPanel({ onPlan, loading, messages }: ChatPanelProps) {
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
            <h1 className="text-base font-semibold text-slate-900">TimeGap AI</h1>
            <p className="text-[11px] text-slate-400">智能规划你的行程间隙时间</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="text-center py-8 text-slate-400">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p className="text-sm">告诉我你的日程，我来帮你规划空闲时间</p>
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

      {/* Example Prompts */}
      {showExamples && messages.length === 0 && (
        <div className="px-6 pb-3">
          <p className="text-[11px] text-slate-400 mb-2">试试这些：</p>
          <div className="space-y-2">
            {EXAMPLE_PROMPTS.map((ex, i) => (
              <button
                key={i}
                onClick={() => {
                  setInput(ex);
                  setShowExamples(false);
                }}
                className="w-full text-left text-xs px-3 py-2 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded-lg transition-colors text-slate-600 hover:text-blue-700 line-clamp-2"
              >
                {ex}
              </button>
            ))}
          </div>
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

      {/* Input */}
      <div className="px-6 pb-6 pt-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="描述你的空闲时间和偏好..."
            className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={loading}
          />
          <button
            onClick={() => handleSubmit()}
            disabled={loading || !input.trim()}
            className="px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
