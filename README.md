This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Environment

Both keys below are **optional** and **read only on the server**. They are
never bundled into the client. Copy `.env.example` to `.env.local` and fill in
whichever you have.

### `PERPLEXITY_API_KEY` (optional)

Used inside `/api/plan` to parse natural-language constraints with Perplexity.
When the key is missing, the call times out, or the response is invalid, the
app falls back to the built-in rule-based parser in
`src/lib/constraint-parser.ts`.

### `AMAP_API_KEY` (optional)

Server-side Amap (高德) Web Service key. Apply at
[lbs.amap.com](https://lbs.amap.com/) → 应用管理 → Web 服务 API.

When set, `/api/plan` enriches the planner output with:

- Geocoding for `start_location`, `final_destination`, and each timeline stop.
- Driving-time route estimates (with the planner's晚高峰 weighting re-applied).
- Real Amap navigation/POI URLs on every "在高德打开" button.

The integration is best-effort. Each Amap call has a short timeout and any
failure falls back to the internal demo city graph
(`src/data/shanghai_city_graph.json`). The UI surfaces the active source via a
`数据来源` row: 高德路线估算 / 高德路线 + 演示图 / 演示城市图（高德未配置）.

The key is referenced only inside `src/lib/amap-client.ts` and
`src/lib/amap-enrich.ts`, both of which are imported by server-side route
handlers only.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
