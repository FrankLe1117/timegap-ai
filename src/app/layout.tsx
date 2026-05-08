import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://laststop.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Last Stop 尾程 · 赶在起飞之前，再多玩一会",
    template: "%s · Last Stop 尾程",
  },
  description:
    "距离火车 / 飞机出发只剩几小时？把退房、餐厅、景点和路上时间放进同一张倒推时间表。AI 理解你的中文描述，高德路线验证赶车安全边界，绝不让你迟到。",

  keywords: [
    "\u5c3e\u7a0b\u89c4\u5212",
    "\u51fa\u5dee\u6700\u540e\u4e00\u5929",
    "\u8d76\u706b\u8f66",
    "\u8d76\u98de\u673a",
    "AI \u884c\u7a0b",
    "\u9ad8\u5fb7\u5730\u56fe",
    "Last Stop",
  ],
  authors: [{ name: "Last Stop" }],
  openGraph: {
    title: "Last Stop 尾程 · 赶在起飞之前，再多玩一会",
    description:
      "距离火车 / 飞机出发只剩几小时？AI 帮你把退房、餐厅、景点、路上时间全塞进一张倒推时间表，三方案对比，高德路线验证不迟到。",
    url: SITE_URL,
    siteName: "Last Stop 尾程",
    locale: "zh_CN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Last Stop 尾程",
    description: "赶在起飞之前，再多玩一会 — 火车 / 飞机倒推规划，AI + 高德实时路况。",
  },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1120" },
  ],
};

// Inline pre-hydration script: applies the saved theme (or OS pref) before
// React mounts so users never see a white-flash when arriving in dark mode.
// Kept tiny on purpose; minified on the wire.
const themeBootScript = `
(function(){try{
  var k='laststop:theme';
  var t=localStorage.getItem(k);
  if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}
  document.documentElement.setAttribute('data-theme',t);
}catch(e){}})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-Hans"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        {children}
      </body>
    </html>
  );
}
