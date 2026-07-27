# Sat-Hunt — state brief (2026-07-23)

**What this is:** A browser-based WebXR "vault hunt" (Vite + Three.js + WebXR, plain JS, no backend yet). A green industrial vault room you explore on desktop, mobile, Quest VR and AR passthrough from a single link. The hunt itself (21 hidden sats, scanner, vault burst) is NOT built yet — this is the room, the viewing layer, and the locomotion/input layer. See `README.md` for build/run details.

**Live URLs / deploys:**
- **LIVE:** https://developerofwebxr-oss.github.io/sat-hunt/ — repo `developerofwebxr-oss/sat-hunt` (public), deploys on push to `main` via GitHub Actions → Pages (`.github/workflows/deploy.yml`, repo-guarded). Vite base comes from `BASE_PATH=/sat-hunt/` set in the workflow.
- No backend, no Railway service, no payments yet. (Sats Arena's Railway backend is a *separate* project — not used here.)
- Local dev: `npm run dev` (HTTPS via basic-ssl, needed for LAN/Quest). `HTTP_PREVIEW=1 npx vite` serves plain HTTP for headless browser checks.

**Status:**
Works (verified in real Chrome): all 12 assets load; room shell (floor/walls/ceiling, tiled textures, green emissive + restrained bloom); 6-pillar ring, beams, catwalks, staircase, props, sat coin; vault door **measured-fit** into the vault hole (hole auto-detected by raycast, Ø3.48 m) with `openVault()/closeVault()` hinge rig (stays closed); Screen/VR/AR mode switcher with correct grey-out and never-stuck session exit; walk 1.4 / sprint 2.8 m/s; collision (walls, pillars, vault, props) and stair→catwalk ground height; jump; Left-X pause menu with comfort toggles (all OFF by default, persisted to localStorage); B/Y stubs; ~487k tris / 28 draw calls with instancing.

Broken / whacky / honest:
- **The LIVE URL is Prompt 1 only (scene + viewing).** The whole locomotion + input layer is **local and uncommitted** (15 changed/new files). Nothing on-device can test movement until it's pushed.
- **Asset poly budgets NOT met.** All 10 GLBs arrived hard-capped at ~375k tris; meshopt weld→simplify hit a hard floor (~10k for the pillar even at error 1.0). Staircase ~38k and mining rig ~38k dominate. Needs a real Blender voxel/quadric remesh.
- **Nothing VR/AR has been verified on-device** — no headset/phone pass yet. Desktop Chrome has no WebXR, so VR feel, AR passthrough/shell-off, laser/grip, haptics and mobile touch ergonomics are all unproven.
- Staircase ramp region in `src/layout.js` is an approximation of the mesh footprint; height maths is correct but visual alignment with the treads is unconfirmed.
- Ceiling is deliberately very dim (self-illuminated faintly) — reads as dark.
- Verify gotcha: when the Chrome tab is backgrounded, rAF freezes the render loop. `window.__sat.step(dt)` pumps one logic frame manually.
- No TODO/FIXME markers in the codebase.

**Changed this session:**
- Stood up the project from scratch and **published + deployed it** (new repo, Actions→Pages, all assets/Draco resolving under `/sat-hunt/`, verified live in real Chrome).
- Decimated all 10 assets 375k → ~9–38k tris each and kept pristine originals in `assets-src/raw/` (outside `public/`, so they never ship).
- Auto-measured the vault hole and fitted the door to it; fixed a bug where the door rendered at 16 m (nested world-scale double-multiply).
- Added the full locomotion/input layer: `input.js`, `locomotion.js`, `collision.js`, `environment.js` (AR shell-off), `interaction.js`, `pausemenu.js`, `comfort.js`, `haptics.js`, `vignette.js` — **uncommitted**.
- Aligned desktop/mobile bindings to the cross-input parity standard (Esc/M menu, E-hold + right-click grab, F fly, on-screen BUILD/SCAN, joystick-edge sprint) and moved the spawn clear of a mining-rig collider.
- Extended the shared `webxr-threejs` skill with the Controller & Input Standard, the AR shell-off rule, and the cross-input parity table.

**Next steps:**
1. Commit + push the locomotion/input work to `main` so the live URL actually has it (blocks everything below).
2. On-device pass: Quest (Enter VR — stick feel, sprint, turn softness, laser/grip, haptics) and phone (AR passthrough + shell-off, touch ergonomics).
3. Blender voxel/quadric remesh of the heavy props to reach the poly budget and Quest 72fps headroom.
4. Confirm the staircase climb lines up with the visible treads; nudge the `ramp` constants in `src/layout.js`.
5. Build the hunt gameplay: 21-sat spawn, scanner reveal (Y), vault burst via `openVault()`.

**Open decisions / blockers:**
- **Needs a human go-ahead to deploy** the uncommitted locomotion layer — it was never pushed.
- `ENABLE_FLY` is defaulted **OFF** (so players can't float above cover in a hide-and-seek hunt) — confirm that's the intent before gameplay.
- Remesh before or after gameplay? Current ~487k tris is fine on desktop, risky on Quest.
- Payments/Lightning are entirely unstarted — no backend or wallet chosen for this project yet.

**Infra notes:** GitHub repo `developerofwebxr-oss/sat-hunt` (public), GitHub Pages via GitHub Actions (Pages source = GitHub Actions). No Railway service, no wallet, no secrets of any kind in this repo.
