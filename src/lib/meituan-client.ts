/**
 * Meituan / Dianping client scaffold.
 *
 * The Meituan/Dianping open API requires signed requests with an app secret
 * and approved categories, which we do not have yet. To keep the planner
 * pipeline compilable today, this module exports a typed surface that mirrors
 * the eventual real client and is a no-op until both `MEITUAN_APP_KEY` and
 * `MEITUAN_APP_SECRET` are present.
 *
 * IMPORTANT: do not claim Dianping integration in any UI surface unless
 * `isMeituanConfigured()` is true and at least one deal was returned.
 */
import { AmapCoord } from "./amap-client";

export interface MeituanDeal {
  id: string;
  name: string;
  coord: AmapCoord;
  address?: string;
  district?: string;
  /** Optional rating from Dianping (0-5). */
  rating?: number;
  /** Optional avg price per person (RMB). */
  pricePerPerson?: number;
}

export interface MeituanSearchInput {
  keyword: string;
  coord: AmapCoord | null;
  city?: string;
  /** Search radius in meters; ignored when coord is null. */
  radius?: number;
  limit?: number;
}

export function isMeituanConfigured(): boolean {
  return !!process.env.MEITUAN_APP_KEY && !!process.env.MEITUAN_APP_SECRET;
}

/**
 * Search Meituan/Dianping deals.
 *
 * Currently returns an empty array unconditionally. The real implementation
 * will sign requests with HMAC-SHA1 against the Meituan open platform once
 * credentials and category permissions are granted.
 */
export async function searchMeituanDeals(input: MeituanSearchInput): Promise<MeituanDeal[]> {
  // No-op scaffold. Returning [] keeps callers' fallback logic simple.
  void input;
  if (!isMeituanConfigured()) return [];

  // TODO: implement signed request once credentials are provisioned.
  // 1. Build payload with required fields (appkey, sign_key, timestamp, etc.)
  // 2. Sort, concatenate, HMAC-SHA1 sign with MEITUAN_APP_SECRET.
  // 3. POST to https://api.meituan.com/.../deals/search
  // 4. Map response → MeituanDeal[].
  return [];
}
