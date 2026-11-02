# Beaver Creek: its sky, hills and vista (DEMO_QUALITY_ROADMAP.md V0–V2)

Before and after, on the Xbox 360 tier (its shading, at its 1280×720 frame, presented from the GPU), from the capture views of `scripts/capture-aaa.mjs`. Each `<map>-<view>.jpg` stacks before over after, both at 1280×720.

- **Before** is the map as it shipped: `captures/f11a` (the creek and base views), or a capture taken here first (the overview).
- **After** has all three items:
  - V0, the sky drawn behind an editor's camera;
  - V1, Beaver's own sky;
  - V2, the hills round the canyon and the vista beyond.
- `beaver-gorge.jpg` is a new view (`gorge`), low and looking along the creek out through its gorge. It is the one view with open sky in it, so it has no before.

## How they were made

```sh
# the web app, with dummy Supabase settings
cd apps/web && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy npx next dev -p 3100
# then, one view at a time (each takes 10–17 minutes on SwiftShader)
node scripts/capture-aaa.mjs <out dir> beaver http://localhost:3100 1 overview,creek,base,gorge before
```

The web app takes the player from its committed `dist`, so a change to `packages/player` shows only after `npm run build --workspace packages/player`.

## What they show

- **The black band is gone.** In every before, the top of the frame is the cart's own 2D frame: flat navy palette bands, black, and the title text, not the sky.
  - The capture script looks through the editor's camera, which turned the sky dome off with the HUD. V0 fixes that.
  - From these views, the hills (V2) now fill most of what was the band.
- **Past the rims is country.**
  - The overview and the creek look out over the canyon's walls onto hills, with woods drawn as impostors.
  - The base looks across to the far wall and the hills behind it.
  - There is no seam where the hills meet the canyon's ground.
- **The sky up the gorge** is Beaver's own: a soft noon blue with fair-weather cumulus over wooded ridges.
- **Two things for later:**
  - **The shade is darker and greener.** The base view's far wall shows it most. It comes from the new sky's light and the grass, not snow, below. Whether that is right is the midday grade's question (V1's left part), on hardware.
  - **A thin, flat-topped dark strip** shows on the horizon at the far end of the creek's valley in `beaver-gorge.jpg`, where the hills' grid ends and the vista shows through. Lowering the vista's ground near its hole, or raising the hills' last ridge there, would close it.
- **Frame time:** SwiftShader, so only a floor: about 5.9–6.8 s of GPU a frame for these views, as before the change (6.4–6.6 s in `captures/f11a`).
