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
    default: "Last Stop \u5c3e\u7a0b \u00b7 \u79bb\u57ce\u524d\u7684\u6700\u540e\u51e0\u5c0f\u65f6\uff0c\u5b89\u6392\u5f97\u521a\u521a\u597d",
    template: "%s \u00b7 Last Stop \u5c3e\u7a0b",
  },
  description:
    "\u9000\u623f\u540e\u5230\u51fa\u53d1\u524d\uff0c\u628a\u9910\u5385\u3001\u666f\u70b9\u3001\u4ea4\u901a\u548c\u5b89\u5168\u7f13\u51b2\u653e\u5728\u540c\u4e00\u5f20\u65f6\u95f4\u8868\u91cc\u3002AI \u7406\u89e3\u4f60\u7684\u4e2d\u6587\u63cf\u8ff0\uff0c\u9ad8\u5fb7\u8def\u7ebf\u9a8c\u8bc1\u8d76\u8f66\u5b89\u5168\u8fb9\u754c\u3002",
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
    title: "Last Stop \u5c3e\u7a0b \u00b7 \u79bb\u57ce\u524d\u7684\u6700\u540e\u51e0\u5c0f\u65f6",
    description:
      "AI \u89e3\u6790\u4e2d\u6587\u63cf\u8ff0\uff0c\u9ad8\u5fb7\u8def\u7ebf\u9a8c\u8bc1\u8d76\u8f66\u5b89\u5168\u8fb9\u754c\uff0c\u4e09\u79cd\u8def\u7ebf\u4e00\u952e\u5bf9\u6bd4\u3002",
    url: SITE_URL,
    siteName: "Last Stop \u5c3e\u7a0b",
    locale: "zh_CN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Last Stop \u5c3e\u7a0b",
    description: "\u79bb\u57ce\u524d\u7684\u6700\u540e\u51e0\u5c0f\u65f6\uff0c\u5b89\u6392\u5f97\u521a\u521a\u597d\u3002",
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
