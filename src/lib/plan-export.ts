/**
 * Client-side helpers for exporting a plan card as a PNG image.
 *
 * Why a dedicated module: html-to-image is a fairly chunky dependency, and
 * we only want it loaded on demand (when the user clicks 保存图片). Keeping
 * everything behind dynamic import lets the initial bundle stay small and
 * keeps the SSR path free of any DOM-only imports.
 */

import type { Plan } from "@/types";

export interface ExportOptions {
  /** Plan being exported — used for filename construction. */
  plan: Plan;
  /** Optional explicit timestamp (defaults to now); helpful for tests. */
  now?: Date;
  /** PNG pixel ratio. 2 = retina-clean. */
  pixelRatio?: number;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function buildExportFilename(plan: Plan, now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const mi = pad2(now.getMinutes());
  return `timegap-plan-${plan.plan_type}-${yyyy}${mm}${dd}-${hh}${mi}.png`;
}

/**
 * Snapshot a DOM node into a PNG and trigger a browser download.
 *
 * Returns an object describing what happened so the caller can show a
 * status message. Errors are reported via the returned `error` field
 * rather than thrown, so a failed export never crashes the page.
 */
export async function exportPlanNodeToPng(
  node: HTMLElement,
  opts: ExportOptions,
): Promise<{ ok: true; filename: string } | { ok: false; error: string }> {
  if (typeof window === "undefined") {
    return { ok: false, error: "exportPlanNodeToPng can only run in the browser" };
  }
  try {
    const { toPng } = await import("html-to-image");
    const dataUrl = await toPng(node, {
      pixelRatio: opts.pixelRatio ?? 2,
      cacheBust: true,
      backgroundColor: "#ffffff",
      // Ignore clickable href/route_options widgets in the export — they
      // can't function in an image and may leak query params with API keys
      // if a user accidentally pasted one. See the 高德链接不可点击 notice
      // shown in the export footer.
      filter: (n) => {
        if (n instanceof HTMLElement && n.dataset.exportIgnore === "true") return false;
        return true;
      },
    });
    const filename = buildExportFilename(opts.plan, opts.now);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return { ok: true, filename };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误";
    return { ok: false, error: msg };
  }
}
