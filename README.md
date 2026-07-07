# Cartbox (working codename)

A polished fantasy console + cartridge marketplace built on [TIC-80](https://github.com/nesbox/TIC-80) (MIT).
Play tiny games free in the browser; buy the desktop app to make them; sell your carts with creator revenue-share.

**▶ Live static demo:** https://cyohn55.github.io/cartbox/ — play the demo carts and use the full
editor in your browser (work saves to localStorage). Accounts, publishing, and the community
server need the full stack and are disabled in the demo; see `apps/web/scripts/build-static.mjs`.

> **Attribution:** This project builds on TIC-80 by Vadim Grigoruk (nesbox) and contributors, MIT-licensed.
> The TIC-80 copyright and license text are retained in `packages/engine/` and surfaced in the app's About screen.

---

## Monorepo layout

```
tic80-console/
├── BUILD_PLAN.md            # phased build plan (start here)
├── README.md                # this file
├── package.json             # npm workspaces root
├── landing/                 # static signup landing page (deploy first)
│   └── index.html
├── apps/
│   ├── web/                 # Next.js — marketplace, gallery, play pages, API routes
│   │   └── README.md
│   └── desktop/             # Tauri shell wrapping the TIC-80 editor
│       └── README.md
├── packages/
│   ├── engine/              # TIC-80 fork (git submodule) + WASM build scripts
│   │   └── README.md
│   ├── player/              # embeddable web cartridge player (WASM loader)
│   │   └── README.md
│   └── ui/                  # shared React components + design tokens
├── services/
│   └── payments/            # Stripe Connect helpers (payouts, entitlements)
└── infra/                   # deploy config, env templates, IaC notes
```

## Workspaces
This repo uses **npm workspaces**. Each `apps/*` and `packages/*` is an independent package.
TIC-80 itself is vendored as a **git submodule** under `packages/engine/tic80` so upstream stays cleanly separable and easy to pull/patch.

## Getting started (scaffold bootstrap)
```bash
# 1. Clone TIC-80 as a submodule (the engine)
git submodule add https://github.com/nesbox/TIC-80 packages/engine/tic80

# 2. Install workspace deps
npm install

# 3. Build the WASM player (see packages/engine/README.md)
npm run engine:build:wasm

# 4. Run the marketplace app
npm run dev --workspace apps/web

# 5. Deploy the landing page immediately (independent of the rest)
#    Point Netlify/Vercel at ./landing  — see landing/index.html
```

## Build order
Follow `BUILD_PLAN.md`: **landing → web player → marketplace → payments → desktop app → jams/launch.**
Each phase is a shippable vertical slice.

## Environment
Copy `infra/.env.example` to `.env.local` and fill:
`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET`, `R2_BUCKET`,
`STRIPE_SECRET_KEY`, `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_WEBHOOK_SECRET`.
