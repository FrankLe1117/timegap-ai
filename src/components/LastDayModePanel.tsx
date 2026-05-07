"use client";

import { useState } from "react";

const START_OPTIONS = [
  "陆家嘴",
  "外滩",
  "三里屯",
  "国贸",
  "春熙路",
  "天府广场",
  "珠江新城",
  "西湖",
];
const DEST_OPTIONS = [
  "虹桥火车站",
  "浦东机场",
  "北京南站",
  "首都机场",
  "成都东站",
  "广州南站",
  "杭州东站",
];

interface Props {
  onSubmit: (input: string) => void;
  loading: boolean;
}

type Style = "balanced" | "low_risk" | "local_experience";

const STYLE_LABEL: Record<Style, string> = {
  low_risk: "更安全",
  balanced: "均衡",
  local_experience: "更体验",
};

export default function LastDayModePanel({ onSubmit, loading }: Props) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("陆家嘴");
  const [startTime, setStartTime] = useState("12:00");
  const [dest, setDest] = useState("虹桥火车站");
  const [departTime, setDepartTime] = useState("22:00");
  const [luggage, setLuggage] = useState(false);
  const [style, setStyle] = useState<Style>("balanced");

  const handleSubmit = () => {
    if (loading) return;
    const styleZh =
      style === "low_risk"
        ? "优先安全、宁可少玩一个点"
        : style === "local_experience"
          ? "希望本地体验最大化，但不能误车"
          : "在安全和体验之间均衡";
    const luggageZh = luggage ? "我带着行李" : "我没带行李";
    const input = `今天是我出差/旅行最后一天。${startTime}在${start}结束事情，${departTime}从${dest}出发。${luggageZh}。${styleZh}。`;
    onSubmit(input);
    setOpen(false);
  };

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium text-blue-800 hover:bg-blue-50"
      >
        <span className="flex items-center gap-1.5">
          <span>🧭</span>
          <span>尾程规划</span>
          <span className="text-[10px] text-blue-500 font-normal">起点 · 出发时间 · 偏好，一键生成</span>
        </span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2.5">
          {/* Start */}
          <div>
            <p className="text-[11px] text-slate-500 mb-1">现在/结束事情的位置（支持国内多数城市）</p>
            <div className="flex flex-wrap gap-1 mb-1">
              {START_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setStart(opt)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    start === opt
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-slate-600 border-slate-200 hover:border-blue-300"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={start}
                onChange={(e) => setStart(e.target.value)}
                placeholder="例：三里屯／春熙路／珠江新城"
                className="flex-1 text-xs px-2 py-1 border border-slate-200 rounded-md bg-white"
              />
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="text-xs px-2 py-1 border border-slate-200 rounded-md bg-white"
              />
            </div>
          </div>

          {/* Destination */}
          <div>
            <p className="text-[11px] text-slate-500 mb-1">车站/机场 + 出发时间</p>
            <div className="flex flex-wrap gap-1 mb-1">
              {DEST_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setDest(opt)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    dest === opt
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-slate-600 border-slate-200 hover:border-blue-300"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder="例：北京西站／双流机场／萧山机场"
                className="flex-1 text-xs px-2 py-1 border border-slate-200 rounded-md bg-white"
              />
              <input
                type="time"
                value={departTime}
                onChange={(e) => setDepartTime(e.target.value)}
                className="text-xs px-2 py-1 border border-slate-200 rounded-md bg-white"
              />
            </div>
          </div>

          {/* Luggage + style */}
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={luggage}
                onChange={(e) => setLuggage(e.target.checked)}
                className="rounded border-slate-300"
              />
              带行李
            </label>
            <div className="flex gap-1">
              {(Object.keys(STYLE_LABEL) as Style[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStyle(s)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    style === s
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-slate-600 border-slate-200 hover:border-blue-300"
                  }`}
                >
                  {STYLE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
          >
            生成尾程方案
          </button>
        </div>
      )}
    </div>
  );
}
