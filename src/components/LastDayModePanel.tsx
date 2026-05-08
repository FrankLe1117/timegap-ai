"use client";

import { useMemo, useState } from "react";
import { CITY_PROFILES, CityProfile } from "@/lib/city-detect";

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

const CITY_LIST: CityProfile[] = Object.values(CITY_PROFILES);

/** Pick up to N non-terminal anchors (start候选) for a city. */
function startCandidates(profile: CityProfile, n = 6): string[] {
  return profile.anchors
    .filter((a) => !a.terminal)
    .slice(0, n)
    .map((a) => a.name);
}

/** Pick all terminals (火车站/机场) for a city. */
function destCandidates(profile: CityProfile): string[] {
  return profile.anchors.filter((a) => a.terminal).map((a) => a.name);
}

export default function LastDayModePanel({ onSubmit, loading }: Props) {
  const [open, setOpen] = useState(false);
  const [cityKey, setCityKey] = useState<string>("shanghai");
  const profile = useMemo(
    () => CITY_PROFILES[cityKey as keyof typeof CITY_PROFILES] || CITY_PROFILES.shanghai,
    [cityKey]
  );
  const starts = useMemo(() => startCandidates(profile), [profile]);
  const dests = useMemo(() => destCandidates(profile), [profile]);

  const [start, setStart] = useState(profile.defaultStart);
  const [startTime, setStartTime] = useState("12:00");
  const [dest, setDest] = useState(profile.defaultDest);
  const [departTime, setDepartTime] = useState("22:00");
  const [luggage, setLuggage] = useState(false);
  const [style, setStyle] = useState<Style>("balanced");

  const handleCityChange = (key: string) => {
    setCityKey(key);
    const next =
      CITY_PROFILES[key as keyof typeof CITY_PROFILES] || CITY_PROFILES.shanghai;
    setStart(next.defaultStart);
    setDest(next.defaultDest);
  };

  const handleSubmit = () => {
    if (loading) return;
    const styleZh =
      style === "low_risk"
        ? "优先安全、宁可少玩一个点"
        : style === "local_experience"
          ? "希望本地体验最大化，但不能误车"
          : "在安全和体验之间均衡";
    const luggageZh = luggage ? "我带着行李" : "我没带行李";
    const input = `今天是我在${profile.zh}出差/旅行的最后一天。${startTime}在${start}结束事情，${departTime}从${dest}出发。${luggageZh}。${styleZh}。`;
    onSubmit(input);
    setOpen(false);
  };

  return (
    <div className="rounded-xl border border-blue-200 dark:border-blue-900/70 bg-blue-50/40 dark:bg-blue-950/30 overflow-hidden transition-colors">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium text-blue-800 dark:text-blue-200 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <span>🧭</span>
          <span>尾程规划</span>
          <span className="text-[10px] text-blue-500 dark:text-blue-400 font-normal">
            选城市 · 起点 · 出发时间，一键生成
          </span>
        </span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2.5 animate-fade-in">
          {/* City selector */}
          <div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">
              城市（决定下方候选）
            </p>
            <div className="flex flex-wrap gap-1">
              {CITY_LIST.map((c) => (
                <button
                  key={c.key}
                  onClick={() => handleCityChange(c.key)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                    cityKey === c.key
                      ? "bg-blue-600 dark:bg-blue-500 text-white border-blue-600 dark:border-blue-500"
                      : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700"
                  }`}
                >
                  {c.zh}
                </button>
              ))}
            </div>
          </div>

          {/* Start */}
          <div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">
              现在/结束事情的位置（{profile.zh}热门地标）
            </p>
            <div className="flex flex-wrap gap-1 mb-1">
              {starts.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setStart(opt)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                    start === opt
                      ? "bg-blue-600 dark:bg-blue-500 text-white border-blue-600 dark:border-blue-500"
                      : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700"
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
                placeholder={`例：${starts.slice(0, 2).join("／")}`}
                className="flex-1 text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500"
              />
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
              />
            </div>
          </div>

          {/* Destination */}
          <div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-1">
              车站/机场 + 出发时间（{profile.zh}主要枢纽）
            </p>
            <div className="flex flex-wrap gap-1 mb-1">
              {dests.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setDest(opt)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                    dest === opt
                      ? "bg-blue-600 dark:bg-blue-500 text-white border-blue-600 dark:border-blue-500"
                      : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700"
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
                placeholder={dests[0] ? `例：${dests[0]}` : "例：火车站／机场"}
                className="flex-1 text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500"
              />
              <input
                type="time"
                value={departTime}
                onChange={(e) => setDepartTime(e.target.value)}
                className="text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
              />
            </div>
          </div>

          {/* Luggage + style */}
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={luggage}
                onChange={(e) => setLuggage(e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-600"
              />
              带行李
            </label>
            <div className="flex gap-1">
              {(Object.keys(STYLE_LABEL) as Style[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStyle(s)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                    style === s
                      ? "bg-blue-600 dark:bg-blue-500 text-white border-blue-600 dark:border-blue-500"
                      : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700"
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
            className="w-full text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 text-white rounded-lg disabled:opacity-50 transition-colors"
          >
            生成尾程方案
          </button>
        </div>
      )}
    </div>
  );
}
