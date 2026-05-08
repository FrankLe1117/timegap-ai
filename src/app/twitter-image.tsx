// Twitter card mirrors the Open Graph image so social previews stay in sync.
// Next.js requires `runtime` to be declared locally — it cannot be re-exported.
import OpenGraphImage from "./opengraph-image";

export const runtime = "edge";
export const alt = "Last Stop 尾程 — 把最后几个小时活成一段记忆";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function TwitterImage() {
  return OpenGraphImage();
}
