import { Constraints, TimeBudget, PlanResponse } from "@/types";

interface Props {
  data: PlanResponse | null;
  onClose?: () => void;
}

const PREFERENCE_LABELS: Record<string, string> = {
  local_food: "本地菜",
  local_experience: "本地体验",
  coffee: "咖啡",
  city_walk: "City Walk",
  shopping: "购物",
  museum: "博物馆",
  attraction: "景点",
  rest: "休整",
  light_meal: "轻食",
  bar: "小酌",
};

const CONSTRAINT_LABELS: Record<string, string> = {
  avoid_tourist: "避开游客密集",
  avoid_long_walk: "少走路",
  no_queue: "不想排队",
  indoor_only: "室内为主",
};

const PLAN_STYLE_LABELS: Record<Constraints["plan_style"], string> = {
  balanced: "均衡",
  low_risk: "稳妥优先",
  local_experience: "本地体验优先",
};

const WALK_LABELS: Record<Constraints["walking_preference"], string> = {
  low: "少走路",
  medium: "适中",
  high: "可多走",
};

function fmtMin(min: number): string {
  if (min <= 0) return "0分钟";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分`;
}

function prefLabel(p: string): string {
  return PREFERENCE_LABELS[p] || p;
}

function constraintLabel(c: string): string {
  return CONSTRAINT_LABELS[c] || c;
}

function HeaderBar({ onClose }: { onClose?: () => void }) {
  return (
    <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
        <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">尾程约束</h3>
        <span className="text-[11px] text-slate-400 dark:text-slate-500">AI 解析的硬性边界 + 软性偏好</span>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="收起尾程约束面板"
          className="text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-3.5 space-y-2.5">
      <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
        告诉左侧 AI 你的尾程信息（在哪、几点结束、几点哪个站/机场离开），
        我们会把<strong className="text-slate-700 dark:text-slate-200">不能违反的硬性边界</strong>
        和<strong className="text-slate-700 dark:text-slate-200">你的偏好</strong>提取到这里，方便你核对。
      </p>
      <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2.5 space-y-1.5">
        <p className="text-[11px] font-medium text-slate-600 dark:text-slate-300">尾程约束会包含</p>
        <ul className="text-[11px] text-slate-500 dark:text-slate-400 space-y-1 leading-relaxed">
          <li className="flex gap-1.5">
            <span className="text-slate-400 dark:text-slate-500">·</span>
            <span>当前位置 / 结束时间</span>
          </li>
          <li className="flex gap-1.5">
            <span className="text-slate-400 dark:text-slate-500">·</span>
            <span>目标车站或机场 / 出发时间</span>
          </li>
          <li className="flex gap-1.5">
            <span className="text-slate-400 dark:text-slate-500">·</span>
            <span>最晚到站时间与可规划窗口</span>
          </li>
          <li className="flex gap-1.5">
            <span className="text-slate-400 dark:text-slate-500">·</span>
            <span>口味、节奏、预算、行李、天气等软偏好</span>
          </li>
          <li className="flex gap-1.5">
            <span className="text-slate-400 dark:text-slate-500">·</span>
            <span>不会把时间排满的安全缓冲解释</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function HardConstraintsSection({
  constraints,
  timeBudget,
}: {
  constraints: Constraints;
  timeBudget: TimeBudget;
}) {
  return (
    <div className="px-4 py-2.5 space-y-2">
      <p className="text-[11px] font-medium text-slate-600 dark:text-slate-300">硬性边界（AI 解析）</p>
      <div className="space-y-1.5">
        <Row
          label="当前位置"
          primary={constraints.start_location || "未指定"}
          secondary={constraints.start_time ? `${constraints.start_time} 起可规划` : undefined}
          dotClass="bg-emerald-500"
        />
        <Row
          label={timeBudget.terminal_kind_label ? `目标 · ${timeBudget.terminal_kind_label}` : "目标终点"}
          primary={constraints.final_destination || "未指定"}
          secondary={constraints.departure_time ? `${constraints.departure_time} 出发` : undefined}
          dotClass="bg-rose-500"
        />
        {constraints.recommended_arrival_time && (
          <Row
            label="期望到站"
            primary={constraints.recommended_arrival_time}
            secondary="你提到的提早到站时间"
            dotClass="bg-amber-400"
          />
        )}
        <Row
          label="最晚出发去终点"
          primary={timeBudget.latest_leave_for_station || "—"}
          secondary={`再晚出发就有赶不上的风险 · 末程约 ${timeBudget.estimated_final_transfer_min} 分钟`}
          dotClass="bg-red-500"
          primaryClass="text-red-600 dark:text-red-400"
        />
        <Row
          label="可规划窗口"
          primary={fmtMin(timeBudget.safe_activity_time_min ?? timeBudget.free_window_min)}
          secondary={`${constraints.start_time || "起点"} → ${timeBudget.latest_leave_for_station || "出发去终点"}`}
          dotClass="bg-blue-500"
        />
      </div>
    </div>
  );
}

function Row({
  label,
  primary,
  secondary,
  dotClass,
  primaryClass,
}: {
  label: string;
  primary: string;
  secondary?: string;
  dotClass: string;
  primaryClass?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass} mt-1.5 shrink-0`} />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-slate-400 dark:text-slate-500">{label}</p>
        <p className={`text-xs font-medium truncate ${primaryClass || "text-slate-800 dark:text-slate-100"}`}>{primary}</p>
        {secondary && <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">{secondary}</p>}
      </div>
    </div>
  );
}

function SoftPreferencesSection({ constraints }: { constraints: Constraints }) {
  const food = constraints.food_preference || [];
  const prefs = constraints.preferences || [];
  const cons = constraints.constraints || [];
  const hasAny =
    food.length > 0 ||
    prefs.length > 0 ||
    cons.length > 0 ||
    constraints.budget_per_person != null ||
    constraints.luggage ||
    constraints.weather === "rainy" ||
    constraints.walking_preference !== "medium" ||
    constraints.plan_style !== "balanced";

  if (!hasAny) {
    return (
      <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800">
        <p className="text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">软性偏好</p>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">
          暂无具体偏好。在左侧聊天里追加「想吃本地菜 / 少走路 / ¥200 以内」等细节即可。
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 space-y-2">
      <p className="text-[11px] font-medium text-slate-600 dark:text-slate-300">软性偏好</p>
      <div className="flex flex-wrap gap-1">
        {food.map((f) => (
          <Chip key={`food-${f}`} tone="amber">
            🍜 {f}
          </Chip>
        ))}
        {prefs.map((p) => (
          <Chip key={`pref-${p}`} tone="blue">
            {prefLabel(p)}
          </Chip>
        ))}
        {cons.map((c) => (
          <Chip key={`con-${c}`} tone="slate">
            {constraintLabel(c)}
          </Chip>
        ))}
        {constraints.plan_style && constraints.plan_style !== "balanced" && (
          <Chip tone="violet">节奏 · {PLAN_STYLE_LABELS[constraints.plan_style]}</Chip>
        )}
        {constraints.walking_preference && constraints.walking_preference !== "medium" && (
          <Chip tone="slate">步行 · {WALK_LABELS[constraints.walking_preference]}</Chip>
        )}
        {constraints.budget_per_person != null && (
          <Chip tone="emerald">人均 ≤ ¥{constraints.budget_per_person}</Chip>
        )}
        {constraints.luggage && <Chip tone="amber">携带行李</Chip>}
        {constraints.weather === "rainy" && <Chip tone="blue">下雨天 · 偏室内</Chip>}
      </div>
    </div>
  );
}

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "blue" | "amber" | "emerald" | "violet" | "slate";
}) {
  const cls: Record<string, string> = {
    blue: "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300",
    amber: "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300",
    emerald: "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300",
    violet: "bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300",
    slate: "bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] ${cls[tone]}`}>
      {children}
    </span>
  );
}

function SafetyBufferSection({ timeBudget }: { timeBudget: TimeBudget }) {
  const kindLabel = timeBudget.terminal_kind_label || "终点";
  const isAirport =
    timeBudget.terminal_kind === "domestic_flight" ||
    timeBudget.terminal_kind === "international_flight";

  let copy = `已为 ${kindLabel} 预留 ${timeBudget.station_buffer_min} 分钟到站缓冲，不会把时间排满到最后一刻。`;
  if (isAirport) {
    copy = `${kindLabel}缓冲较长（约 ${timeBudget.station_buffer_min} 分钟），覆盖值机、安检、登机口步行与可能的延误。`;
  } else if (timeBudget.terminal_kind === "high_speed_rail" || timeBudget.terminal_kind === "train") {
    copy = `火车/高铁站预留约 ${timeBudget.station_buffer_min} 分钟，包含进站取票、安检和找站台时间，留出余量不至于狂奔。`;
  }

  return (
    <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/30 space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-slate-600 dark:text-slate-300">安全缓冲与风险</p>
        <span className="text-[11px] text-slate-400 dark:text-slate-500">
          {kindLabel} · {timeBudget.station_buffer_min}分钟
        </span>
      </div>
      <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">{copy}</p>
      {timeBudget.buffer_addons && timeBudget.buffer_addons.length > 0 && (
        <ul className="text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5">
          {timeBudget.buffer_addons.map((a, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-600" />
              <span>
                {a.label} <span className="text-slate-400 dark:text-slate-500">+{a.minutes}分</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {timeBudget.buffer_reason && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug italic">{timeBudget.buffer_reason}</p>
      )}
      {timeBudget.rush_hour_detected && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1 shrink-0" />
          <span className="leading-snug">
            {timeBudget.rush_hour_note || "已识别晚高峰时段，通勤时间已自动加权，避免临门一脚被堵在路上。"}
          </span>
        </div>
      )}
    </div>
  );
}

export default function TripConstraintsPanel({ data, onClose }: Props) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <HeaderBar onClose={onClose} />
      {!data ? (
        <EmptyState />
      ) : (
        <div>
          <HardConstraintsSection constraints={data.parsedConstraints} timeBudget={data.timeBudget} />
          <SoftPreferencesSection constraints={data.parsedConstraints} />
          <SafetyBufferSection timeBudget={data.timeBudget} />
        </div>
      )}
    </div>
  );
}
