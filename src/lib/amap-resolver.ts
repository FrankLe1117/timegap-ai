/**
 * Amap-driven location resolution.
 *
 * Why this exists: the original parser leaned on a small Chinese-city registry
 * + a Shanghai default whenever it could not extract a clean (city, start,
 * destination) tuple from the user's free-form input. That worked for the
 * common Shanghai case but silently mis-located trips in cities the registry
 * doesn't cover, and even mis-resolved short names like "钟楼" / "火车站" in
 * cities it does cover (because the registry only listed signature POIs).
 *
 * This module owns a higher-resolution, Amap-first resolution layer:
 *
 *   1. Pick a *city context* from the original text or from the rule/LLM
 *      parser's guess. We prefer a city the rule/LLM parser was confident
 *      about; we fall back to letting Amap discover the city from the start
 *      or destination string itself.
 *   2. Resolve start and destination strings to concrete Amap POIs *with*
 *      city context, so "钟楼" in a Xi'an trip becomes 西安 钟楼 and not the
 *      Shanghai default.
 *   3. Derive a `terminalKind` from Amap's POI type / name when the destination
 *      looks like a station or airport — feeds the buffer logic.
 *
 * Behaviour when `AMAP_API_KEY` is missing: every helper short-circuits to
 * `null`. Callers must continue to handle that case via the existing city
 * registry / manual-confirm path. Resolver never invents a Shanghai fallback
 * by itself.
 */

import {
  AmapPoi,
  geocodeAddress,
  geocodePlace,
  isAmapConfigured,
  searchPoiByKeyword,
} from "./amap-client";

/**
 * Pluggable Amap dependency surface for tests. Production passes the live
 * `amap-client` exports; smoke tests provide canned responses and an
 * `isConfigured: true` so the resolver runs end-to-end without hitting the
 * network.
 */
export interface AmapResolverDeps {
  isConfigured: () => boolean;
  searchByKeyword: (keyword: string, city: string, limit: number) => Promise<AmapPoi[]>;
  geocodeAddress: (query: string, city?: string) => Promise<AmapPoi | null>;
  geocodePlace: (query: string, city?: string) => Promise<AmapPoi | null>;
}

const DEFAULT_DEPS: AmapResolverDeps = {
  isConfigured: isAmapConfigured,
  searchByKeyword: searchPoiByKeyword,
  geocodeAddress: geocodeAddress,
  geocodePlace: (q, c) => (c ? geocodePlace(q, c) : geocodeAddress(q)),
};
import {
  CityProfile,
  cityNameForAmap,
  detectCity,
  findProfileByCityName,
} from "./city-detect";
import type { Constraints, ResolvedPlace } from "@/types";

export interface ResolvedLocationContext {
  /** Chinese city name (e.g. "广州" / "西安") suitable for Amap's `city` arg. */
  cityName: string;
  /** When the resolved city matches a known profile, exposes it for callers
   *  that still want city-specific defaults / synonyms. May be null when Amap
   *  resolved a city we don't have a profile for (legitimate — every Tier-1
   *  city we don't pre-register still works via Amap). */
  profile: CityProfile | null;
  /** Amap city code returned by geocode/POI search, when available. */
  cityCode?: string;
  /** Amap adcode returned by geocode/POI search, when available. */
  adcode?: string;
  /** Resolved start POI, when one of the candidate strings matched. */
  start: ResolvedPlace | null;
  /** Resolved destination POI, when one of the candidate strings matched. */
  destination: ResolvedPlace | null;
  /** True when at least one Amap call succeeded — lets the caller decide
   *  whether to override the parser's city/anchor guesses. */
  amapUsed: boolean;
}

const TRAIN_TYPE_HINTS = /火车站|铁路|高铁|动车|铁道|站$|站点|railway|train/i;
const AIRPORT_TYPE_HINTS = /机场|航站|airport|terminal/i;
const INTERNATIONAL_TEXT_HINTS = /国际航班|国际线|国际航线|出境|海关|护照|跨境/i;

function inferTerminalKind(
  poi: AmapPoi,
  userText: string,
): ResolvedPlace["terminalKind"] {
  const blob = `${poi.name || ""} ${poi.type || ""} ${poi.address || ""} ${userText}`;
  const isAirport = AIRPORT_TYPE_HINTS.test(blob);
  if (isAirport) {
    if (INTERNATIONAL_TEXT_HINTS.test(userText)) return "international_flight";
    return "domestic_flight";
  }
  const isTrain = TRAIN_TYPE_HINTS.test(blob);
  if (isTrain) {
    if (/高铁|动车|高速铁路|G\d|D\d/i.test(blob)) return "high_speed_rail";
    return "train";
  }
  return undefined;
}

function poiToResolved(
  poi: AmapPoi,
  source: ResolvedPlace["source"],
  userText: string,
  preferTerminal: boolean,
): ResolvedPlace {
  const terminalKind = preferTerminal ? inferTerminalKind(poi, userText) : undefined;
  return {
    name: poi.name,
    lng: poi.coord.lng,
    lat: poi.coord.lat,
    cityName: poi.cityName,
    cityCode: poi.cityCode,
    adcode: poi.adcode,
    district: poi.district,
    type: poi.type,
    terminalKind,
    source,
  };
}

/**
 * Resolve a free-text place name to an Amap POI within an optional city
 * context. Tries `place/text` (POI search, biased to the city) first, then
 * falls back to `geocode/geo` for plain addresses. Returns null on any miss.
 */
async function resolvePlace(
  query: string,
  cityHint: string | null,
  userText: string,
  preferTerminal: boolean,
  deps: AmapResolverDeps,
): Promise<ResolvedPlace | null> {
  const trimmed = (query || "").trim();
  if (!trimmed) return null;
  if (!deps.isConfigured()) return null;

  // Place/text first — picks "西安钟楼" over a generic geocode for ambiguous
  // single-word names. The Amap call only filters by city when one is given,
  // so we still benefit from the search when the city is unknown.
  const pois = await deps.searchByKeyword(trimmed, cityHint || "", 5);
  if (pois.length > 0) {
    const top =
      // Prefer a POI whose city matches the hint when one exists.
      (cityHint
        ? pois.find((p) =>
            p.cityName && cityNamesEqual(p.cityName, cityHint),
          )
        : null) || pois[0];
    return poiToResolved(top, "amap_poi", userText, preferTerminal);
  }

  // Fall back to geocode (handles addresses like "西安市未央区站前路").
  const geo = cityHint ? await deps.geocodePlace(trimmed, cityHint) : await deps.geocodeAddress(trimmed);
  if (geo) return poiToResolved(geo, "amap_geocode", userText, preferTerminal);

  return null;
}

function cityNamesEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.replace(/(市|区|省|特别行政区)$/u, "").trim().toLowerCase();
  return norm(a) === norm(b);
}

interface ResolveOptions {
  /** Original user text — used to disambiguate terminal kind. */
  userText: string;
  /** City the rule/LLM parser thinks the user meant. May be empty when the
   *  parser only had ambiguous signals — the resolver will then ask Amap. */
  parserCity?: string;
  /** Start location string surfaced by the parser. */
  startQuery?: string;
  /** Destination string surfaced by the parser. */
  destQuery?: string;
}

/**
 * Run the full resolver. Steps:
 *
 *   1. Determine a CN city name. Order: explicit `parserCity` (when known) →
 *      city detected from the user's text → null (let Amap discover one).
 *   2. Resolve `startQuery` and `destQuery` (when present) against Amap with
 *      that city as a hint. If a query resolves to a different city than the
 *      hint and the parser's city was a low-confidence Shanghai default, we
 *      adopt the resolved city instead — this is the fix for "西安出差..."
 *      where the parser would otherwise return Shanghai.
 *   3. Return a context the route handler can use to overwrite weak parser
 *      guesses with Amap-resolved coordinates.
 *
 * Returns null when AMAP_API_KEY is missing or every Amap call fails.
 */
export async function resolveLocationContext(
  opts: ResolveOptions,
  deps: AmapResolverDeps = DEFAULT_DEPS,
): Promise<ResolvedLocationContext | null> {
  if (!deps.isConfigured()) return null;

  const userText = opts.userText || "";
  // Stage 1: pick a city hint.
  const detected = detectCity(userText);
  const detectedFromText = detected.key !== "shanghai" || textMentionsShanghai(userText);
  const parserProfile = opts.parserCity ? findProfileByCityName(opts.parserCity) : null;

  // Prefer the parser's explicit city when it matches a profile and is not the
  // weak Shanghai default. Otherwise prefer the text-detected city when it is
  // unambiguous. Otherwise leave the hint blank and let Amap discover.
  let hint: string | null = null;
  let hintProfile: CityProfile | null = null;
  if (parserProfile && (parserProfile.key !== "shanghai" || parserCityIsConfident(opts.parserCity, userText))) {
    hint = parserProfile.zh;
    hintProfile = parserProfile;
  } else if (detectedFromText) {
    hint = detected.zh;
    hintProfile = detected;
  }

  // Stage 2: resolve start + destination in parallel.
  const [start, destination] = await Promise.all([
    resolvePlace(opts.startQuery || "", hint, userText, false, deps),
    resolvePlace(opts.destQuery || "", hint, userText, true, deps),
  ]);

  // Stage 3: reconcile city. If neither query resolved and we have no hint,
  // give up rather than guess Shanghai.
  let finalCityName = hint;
  let finalAdcode: string | undefined;
  let finalCityCode: string | undefined;
  let finalProfile: CityProfile | null = hintProfile;

  // Promote the resolved POI's city when:
  //   - we had no hint, or
  //   - the hint was the weak Shanghai default and the POI clearly disagrees.
  const candidatePoi = start || destination;
  if (candidatePoi?.cityName) {
    const poiProfile = findProfileByCityName(candidatePoi.cityName);
    const promote =
      !finalCityName ||
      (hintProfile?.key === "shanghai" && !parserCityIsConfident(opts.parserCity, userText) &&
        !cityNamesEqual(candidatePoi.cityName, finalCityName));
    if (promote) {
      finalCityName = poiProfile ? poiProfile.zh : candidatePoi.cityName;
      finalProfile = poiProfile;
    }
    finalAdcode = candidatePoi.adcode;
    finalCityCode = candidatePoi.cityCode;
  }

  if (!finalCityName) return { cityName: "", profile: null, start, destination, amapUsed: !!candidatePoi };

  return {
    cityName: cityNameForAmap(finalCityName),
    profile: finalProfile,
    adcode: finalAdcode,
    cityCode: finalCityCode,
    start,
    destination,
    amapUsed: true,
  };
}

function textMentionsShanghai(text: string): boolean {
  return /上海|沪|shanghai/i.test(text);
}

/**
 * The parser may have returned "Shanghai" because (a) the user really did
 * mean Shanghai, or (b) it had nothing to go on and used the legacy default.
 * We treat (a) as confident: the original text mentions Shanghai or a
 * Shanghai-only signature anchor. Otherwise we treat the parser's Shanghai as
 * weak and let the Amap-resolved city win.
 */
function parserCityIsConfident(parserCity: string | undefined, userText: string): boolean {
  if (!parserCity) return false;
  const profile = findProfileByCityName(parserCity);
  if (!profile) return false;
  if (profile.key !== "shanghai") return true;
  // Shanghai is confident only when the original text references it.
  return textMentionsShanghai(userText);
}

/**
 * Apply a resolver result to a Constraints object. Mutates a copy. Used by
 * the API route handler so existing call-sites continue to receive a single
 * Constraints value with the Amap-resolved fields baked in.
 *
 * Rules:
 *   - When the resolver's city differs from the parser's, override `city`
 *     (English) and `city_cn` (Chinese).
 *   - When a resolved place exists, attach it as `start_place` /
 *     `destination_place` and overwrite the corresponding string with the
 *     POI's normalized name (Amap's "西安钟楼" beats the user's "钟楼").
 *   - Never wipe a parser-supplied value with `null`.
 */
export function applyResolverToConstraints(
  base: Constraints,
  ctx: ResolvedLocationContext,
): Constraints {
  const next: Constraints = { ...base };
  const profile = ctx.profile;
  if (ctx.cityName) {
    next.city_cn = ctx.cityName;
    if (profile) next.city = profile.en;
  }
  if (ctx.start) {
    next.start_place = ctx.start;
    if (ctx.start.name && ctx.start.name.trim().length > 0) next.start_location = ctx.start.name;
  }
  if (ctx.destination) {
    next.destination_place = ctx.destination;
    if (ctx.destination.name && ctx.destination.name.trim().length > 0) next.final_destination = ctx.destination.name;
  }
  return next;
}
