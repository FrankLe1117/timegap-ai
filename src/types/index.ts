export interface CityGraphNode {
  id: string;
  name: string;
  type: "area" | "attraction" | "restaurant" | "cafe" | "mall" | "transport";
  area: string;
  tags: string[];
  luggage_friendly: boolean;
  rain_friendly: boolean;
  walking_intensity: "low" | "medium" | "high";
  local_experience_score: number;
  night_friendly: boolean;
  suggested_duration_min: number;
  price_level?: string;
  price_per_person?: number;
  meal_period?: string[];
  queue_risk?: string;
  risk_to_hongqiao_station: "low" | "medium" | "high";
}

export interface CityGraphEdge {
  from: string;
  to: string;
  base_min: number;
  rush_hour_multiplier: number;
  buffer_min: number;
  mode: string;
  reliability: "high" | "medium" | "low";
}

export interface CityGraph {
  city: string;
  nodes: CityGraphNode[];
  edges: CityGraphEdge[];
}

export interface ResolvedPlace {
  /** Display name (preferring Amap's normalized POI name when available). */
  name: string;
  lng: number;
  lat: number;
  /** Amap-resolved city name (e.g. "广州市"). */
  cityName?: string;
  cityCode?: string;
  adcode?: string;
  district?: string;
  /** Raw Amap POI type string, when we resolved via place/text. */
  type?: string;
  /** Inferred terminal kind for buffer logic. */
  terminalKind?: "high_speed_rail" | "train" | "domestic_flight" | "international_flight" | "generic";
  /** "amap_geocode" for geocode/geo, "amap_poi" for place/text, "city_registry" for fallback. */
  source: "amap_geocode" | "amap_poi" | "city_registry";
}

export interface Constraints {
  city: string;
  /** Chinese city name suitable for downstream Amap calls (e.g. "广州").
   *  When absent, callers should derive it from `city` via cityNameForAmap. */
  city_cn?: string;
  start_location: string;
  start_time: string;
  final_destination: string;
  departure_time: string;
  recommended_arrival_time?: string;
  /** Amap-resolved start POI when available. Carries coords + city/adcode so
   *  downstream candidate-pool / route calls can bias to the correct city
   *  without relying on the English `city` string. */
  start_place?: ResolvedPlace;
  /** Amap-resolved destination POI when available. */
  destination_place?: ResolvedPlace;
  preferences: string[];
  constraints: string[];
  budget_per_person: number | null;
  luggage: boolean;
  weather: "unknown" | "sunny" | "rainy";
  walking_preference: "low" | "medium" | "high";
  food_preference: string[];
  plan_style: "balanced" | "low_risk" | "local_experience";
}

export interface TimeBudget {
  free_window_min: number;
  station_buffer_min: number;
  planning_deadline: string;
  estimated_final_transfer_min: number;
  latest_leave_for_station: string;
  safe_activity_time_min: number;
  rush_hour_detected: boolean;
  rush_hour_note: string;
  /** Detected terminal type used to size the buffer. */
  terminal_kind?: "high_speed_rail" | "train" | "domestic_flight" | "international_flight" | "generic";
  /** Short Chinese label, e.g. "高铁/火车", "国内航班", "国际航班". */
  terminal_kind_label?: string;
  /** Base minutes for the terminal kind, before per-trip add-ons. */
  buffer_base_min?: number;
  /** Per-reason add-ons that contribute to the final buffer. */
  buffer_addons?: { label: string; minutes: number }[];
  /** One-line Chinese explanation of how the buffer was chosen. */
  buffer_reason?: string;
}

/**
 * A single navigation/route option attached to a transport timeline leg.
 * Multiple options (e.g. driving + transit) can be presented side-by-side so
 * the user can open Amap directly into the correct routing mode.
 */
export interface RouteOption {
  mode: "driving" | "transit" | "walking" | "search";
  label: string;
  url: string;
}

export interface TimelineItem {
  start_time: string;
  end_time: string;
  title: string;
  place_name: string;
  place_id?: string;
  activity_type: "transport" | "lunch" | "dinner" | "city_walk" | "coffee" | "attraction" | "station_buffer" | "shopping" | "rest";
  reason: string;
  estimated_travel_time_to_next_min: number | null;
  travel_mode?: string;
  is_rush_hour?: boolean;
  /** Optional GCJ-02 coordinate resolved from Amap; used for nav links. */
  lng?: number;
  lat?: number;
  /** Optional Amap-built navigation URL. */
  amap_url?: string;
  /**
   * For transport legs: list of concrete Amap route URLs (driving / transit /
   * walking / search-fallback). Empty/undefined when we don't know the
   * origin coordinate or the leg is a non-transport stop.
   */
  route_options?: RouteOption[];
  /** Where the place came from. Demo (city graph) is the default. */
  source?: "demo" | "amap" | "meituan";
  /** [0,1] candidate score when the stop was inserted from a real candidate pool. */
  candidate_score?: number;
  /** Reliability tier when the stop came from a real candidate. Used by the
   *  UI to choose between a "高德已验证" badge (confirmed) and a softer
   *  "高德候选" badge (probable). Absent for demo stops. */
  candidate_reliability?: "confirmed" | "probable" | "suggested";
  /**
   * Whether this stop refers to a concrete POI we trust enough to navigate to,
   * or a directional suggestion ("徐汇区附近一家本帮菜小馆") that the UI must
   * NOT decorate with a map link. Absent → treated as "poi" for backwards
   * compatibility.
   *
   * `"search"` is a manual-confirm placeholder: Amap was reachable but no
   * reliable POI clears the gate, so we surface an Amap *search* URL
   * (`search_url`) for the user to pick a place themselves. The UI must label
   * this as a search/confirm link, NOT a verified destination.
   */
  place_kind?: "poi" | "directional" | "search";
  /**
   * Amap keyword-search URL for `place_kind: "search"` stops. Opens Amap with
   * a city + cuisine/area query so the user can pick a real shop. Never
   * present on `"poi"` stops — those use `amap_url` instead.
   */
  search_url?: string;
  /** Human-readable summary of what `search_url` will search for, e.g.
   *  "人民广场 本帮菜". Surfaced in the UI tooltip / accessibility label. */
  search_query?: string;
}

export interface SuitabilityTags {
  time_safety: "High" | "Medium" | "Low";
  rush_hour_exposure: "Low" | "Medium" | "High";
  walking_intensity: "Low" | "Medium" | "High";
  local_experience: "High" | "Medium" | "Low";
  luggage_friendly: "High" | "Medium" | "Low";
  weather_robustness: "High" | "Medium" | "Low";
  station_arrival_confidence: number;
  experience_score: number;
}

export interface RouteHop {
  from: string;
  to: string;
  travel_min: number;
  mode?: string;
  is_rush_hour?: boolean;
  kind: "leg" | "stop";
  stop_duration_min?: number;
  activity_type?: TimelineItem["activity_type"];
}

export interface Plan {
  plan_name: string;
  plan_type: "balanced" | "low_risk" | "local_experience";
  one_sentence_summary: string;
  tradeoff_summary: string;
  suitability_tags: SuitabilityTags;
  timeline: TimelineItem[];
  route_chain: RouteHop[];
  latest_leave_for_station: string;
  risk_note: string;
  backup_suggestion: string;
  explanation: string;
  rush_hour_warning?: string;
}

export interface ReplanChange {
  action: "removed" | "added" | "moved" | "replaced";
  detail: string;
}

export interface ParseResult {
  constraints: Constraints;
  confidence: "high" | "medium" | "low";
  missing: string[];
  assumptions: string[];
  source: "llm" | "rule";
  notes?: string;
}

export interface ClarificationResponse {
  needsClarification: true;
  parseResult: ParseResult;
  message: string;
}

export interface PlanResponse {
  parsedConstraints: Constraints;
  timeBudget: TimeBudget;
  plans: Plan[];
  replanChanges?: ReplanChange[];
  parseMeta?: {
    source: "llm" | "rule";
    confidence: "high" | "medium" | "low";
    assumptions: string[];
    notes?: string;
  };
  dataSources: {
    places: string;
    travelTimes: string;
    apiReady: string;
    /** Stable tag for UI: "amap" when Amap routes were used, "demo" otherwise, "mixed" when partial. */
    routesSource: "amap" | "demo" | "mixed" | "fallback";
    amapConfigured: boolean;
    /** True when at least one stop was sourced from a real candidate pool. */
    candidatesUsed?: boolean;
    /** Distinct candidate sources represented in plans, e.g. ["amap"]. */
    candidateSources?: Array<"amap" | "meituan">;
  };
}

