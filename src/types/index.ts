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

export interface Constraints {
  city: string;
  start_location: string;
  start_time: string;
  final_destination: string;
  departure_time: string;
  recommended_arrival_time?: string;
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
}

export interface SuitabilityTags {
  time_safety: "High" | "Medium" | "Low";
  rush_hour_exposure: "Low" | "Medium" | "High";
  walking_intensity: "Low" | "Medium" | "High";
  local_experience: "High" | "Medium" | "Low";
  luggage_friendly: "High" | "Medium" | "Low";
  weather_robustness: "High" | "Medium" | "Low";
  station_arrival_confidence: number;
}

export interface Plan {
  plan_name: string;
  plan_type: "balanced" | "low_risk" | "local_experience";
  one_sentence_summary: string;
  suitability_tags: SuitabilityTags;
  timeline: TimelineItem[];
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
  };
}

export interface CalendarEvent {
  id: string;
  title: string;
  location: string;
  start_time: string;
  end_time: string;
  date: string;
}

export interface FreeWindow {
  start_time: string;
  end_time: string;
  duration_min: number;
  between: string;
  is_gap: boolean;
}

export interface MockCalendar {
  calendar_events: CalendarEvent[];
  free_windows: FreeWindow[];
}
