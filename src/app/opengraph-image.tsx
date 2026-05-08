import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Last Stop 尾程 — 赶在起飞之前，再多玩一会";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "linear-gradient(135deg, #0b1120 0%, #0f1d3a 40%, #1d2f6f 75%, #2d4ba8 100%)",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
          color: "white",
          padding: "72px",
          position: "relative",
        }}
      >
        {/* Decorative grid lines (timeline feel) */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: 0.06,
            fontSize: 600,
            fontWeight: 900,
            letterSpacing: "-0.05em",
          }}
        >
          ⏱
        </div>

        {/* Header chip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "10px 18px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.18)",
            fontSize: 22,
            color: "#cfe0ff",
            width: "fit-content",
            backdropFilter: "blur(8px)",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: "#34d399",
              boxShadow: "0 0 12px #34d399",
            }}
          />
          Last Stop · 尾程 AI
        </div>

        {/* Title */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 38,
            gap: 18,
          }}
        >
          <div
            style={{
              fontSize: 92,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              display: "flex",
              flexWrap: "wrap",
            }}
          >
            赶在起飞之前
          </div>
          <div
            style={{
              fontSize: 92,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              background: "linear-gradient(90deg, #93c5fd 0%, #c4b5fd 60%, #f0abfc 100%)",
              backgroundClip: "text",
              color: "transparent",
              display: "flex",
            }}
          >
            再多玩一会
          </div>
        </div>

        {/* Subtitle */}
        <div
          style={{
            marginTop: 28,
            fontSize: 28,
            lineHeight: 1.45,
            color: "#cbd5e1",
            maxWidth: 980,
            display: "flex",
          }}
        >
距离火车 / 飞机出发只剩几小时？AI 把退房、餐厅、景点、路上时间塞进一张倒推时间表
        </div>

        {/* Footer row: feature chips + URL */}
        <div
          style={{
            marginTop: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div style={{ display: "flex", gap: 14 }}>
            {[
              { label: "火车 / 飞机倒推", color: "#60a5fa" },
              { label: "高德路线验证不迟到", color: "#34d399" },
              { label: "三方案对比选一个", color: "#fbbf24" },
            ].map((chip) => (
              <div
                key={chip.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 16px",
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  fontSize: 22,
                  color: "#e2e8f0",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: chip.color,
                  }}
                />
                {chip.label}
              </div>
            ))}
          </div>
          <div
            style={{
              fontSize: 22,
              color: "#94a3b8",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              display: "flex",
            }}
          >
            laststop.app
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
