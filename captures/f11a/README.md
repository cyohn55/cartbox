# F11a: Milestone A captures

The before-and-after captures that close Milestone A of `AAA_FIDELITY_ROADMAP.md` ("Correct light"): Lockout and Beaver Creek from the same fixed views, on the tier the maps shipped on and on the AAA tier.

- **Before:** the Xbox 360 tier. This is its shading, at its 1280×720 frame, presented from the GPU (`?present=gpu`). F0a holds that frame to the byte path within half a level on average, and it can be read back without waiting on a readback.
- **After:** the AAA tier's Milestone A path (`?hdr=1&dynres=0`). This adds linear HDR with the physical calibration, the frame graph with a prepass, mips, anisotropy and compressed textures, the multiscatter BRDF, GPU IBL, HDR TAA, grading, bloom and lens effects. It renders at the display's own resolution: 1920×1080 here, a 1280×720 page at a pixel ratio of 1.5.

Each `<map>-<view>.jpg` stacks the pair, before on top, both scaled to 1280×720. `report.json` holds what the run measured for each view: the frame's size, draws and triangles, the GPU time of the scene and of each presenter pass, and the render scale dynamic resolution would settle at.

## How they were made

```sh
# the web app, with dummy Supabase settings
cd apps/web && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy npx next dev -p 3100
# then
node scripts/capture-aaa.mjs <out dir> lockout,beaver http://localhost:3100 1.5
```

The script opens `/lockout?capture=1`, which hands it the player. It starts a Free for All, skips the intro, and puts the player's editor camera on each view. It times the frame while the game plays. It then pauses, steps 20 frames so TAA's history settles, and reads the presented frame back from the GPU, since a screenshot of a WebGPU canvas can come out blank.

## What they show

| Map | View | Mean luminance | Contrast (spread) | Colour (chroma) | Scene GPU, s | Presenter GPU, s |
|---|---|---|---|---|---|---|
| lockout | overview | 0.60 → 0.67 | 0.262 → 0.186 | 0.155 → 0.138 | over 10 → over 10 | 0.34 → 1.51 |
| lockout | walkway | 0.60 → 0.56 | 0.305 → 0.279 | 0.079 → 0.122 | over 10 → over 10 | 0.39 → 1.43 |
| lockout | pit | 0.33 → 0.36 | 0.338 → 0.310 | 0.122 → 0.170 | over 10 → over 10 | 0.41 → 1.48 |
| lockout | skyline | 0.32 → 0.31 | 0.315 → 0.288 | 0.108 → 0.136 | over 10 → over 10 | 0.36 → 1.55 |
| beaver | overview | 0.66 → 0.65 | 0.319 → 0.256 | 0.171 → 0.208 | 6.5 → 8.7 | 0.37 → 1.49 |
| beaver | creek | 0.62 → 0.59 | 0.311 → 0.247 | 0.170 → 0.244 | 6.6 → 8.5 | 0.34 → 1.48 |
| beaver | base | 0.38 → 0.38 | 0.267 → 0.251 | 0.102 → 0.128 | 6.4 → 8.6 | 0.37 → 1.39 |

- **Richer colour, same brightness.** Chroma rises in six of the seven views, by 21% to 54%; overall brightness holds within about a tenth. Metal panels, stone and grass read as materials rather than flat fills.
- **Less contrast in every view (6% to 29%).** This is the calibration F0b-1 left for later, and it has three visible causes:
  - **The sky.** Lockout's painted sky dome is display-referred art, and on the AAA path it is exposed and tone-mapped with the scene. Its blue lifts and pales (90,114,152 → 161,184,202 in the overview), while lit surfaces come out about 0.6 stop darker (the deck 226 → 189).
  - **Fog.** Beaver Creek's fog now mixes in linear light, which lifts the far canyon toward the fog colour.
  - **The sun's bloom.** It spreads wider over the sky.
- **A defect: Beaver Creek's creek water.** On the AAA path it draws as a bright, stretched, speckled pattern instead of water (`beaver-creek.jpg`), while the banks and steps around it are right. It is the next thing to fix.
- **Frame time.** These runs are on SwiftShader, a software GPU, so the times are a floor and say nothing about a device class.
  - The scene's own time is missing for Lockout because its frames took over the frame-graph timer's 10 s sanity bound.
  - Relative cost is meaningful: at 2.25× the pixels, Beaver Creek's scene costs about 1.3× as much, and the presenter about 4×, with the sky, bloom and lens passes it adds.
  - Frame times per device class need the same run on real hardware: `CBX_GPU=1 node scripts/capture-aaa.mjs …` on each machine.
