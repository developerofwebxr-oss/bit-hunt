# Bit-Hunt — Vault scene (Prompt 1: assembly + multi-device viewing)

A WebXR / Three.js vault room that opens from a single link and can be viewed on
desktop, mobile, VR (Quest) and AR (passthrough). This first milestone covers
**scene assembly + viewing only** — no locomotion, collision, gameplay, burst, or
payments yet (those are later prompts; the rig and vault door are pre-rigged so
they drop in cleanly).

## Run

```bash
npm install
npm run dev        # https://localhost:5173 (self-signed cert) + LAN URL for phone/Quest
```

WebXR needs a secure context. `npm run dev` serves HTTPS via `basic-ssl` (needed
for LAN access from a headset/phone). For a quick local check in a plain browser:

```bash
HTTP_PREVIEW=1 npx vite   # http://localhost:5173 (localhost is already a secure context)
```

Build / deploy (static, GitHub-Pages-ready — `base: './'`):

```bash
npm run build      # -> dist/ (includes assets + draco decoder)
```

## Asset pipeline

Source art lives in `assets-src/raw/` (pristine, **not** shipped). The 10 GLBs
arrived from mixed tools, all hard-capped at ~375k triangles. They are decimated
into `public/assets/` (shipped) by:

```bash
npm run inspect    # triangle/bbox/pivot/texture report
npm run decimate   # weld -> meshopt simplify, per-asset budgets
```

### Inspection (raw) & decimation result

| Asset (role) | Raw tris | After decimate | Budget |
|---|---|---|---|
| tall-pillar (pillar) | 374,860 | 9,974 | 300–800 |
| green-beam (beam) | 375,000 | 9,212 | 200–500 |
| catwalk-section | 373,992 | 8,964 | 1–2k |
| staircase-to-catwalk | 374,998 | 37,614 | 1–2k |
| mining-rig | 373,658 | 38,648 | 2–4k |
| storage-crate (vault crate) | 374,712 | 15,866 | 0.5–1k |
| halo-terminal (holo terminal) | 374,994 | 14,580 | 1–2k |
| main-empty-vault | 373,470 | 12,000 | 5–10k |
| main-vault-door | 374,484 | 17,262 | 1–3k |
| bitcoin-sat-coin | 375,000 | 11,604 | 150–400 |

All origins are bottom-center, so floor objects sit on `y=0` after scaling.

**Decimation note:** meshopt simplification hit a hard geometric floor on these
dense organic meshes (~10k for the pillar even at error=1.0), so the tight
per-asset budgets (e.g. pillar 800) were **not** reachable with quadric collapse
alone. Hitting them needs a true remesher (Blender voxel/quadric remesh) — flagged
as a follow-up. Current scene total: **~487k tris across 28 draw calls** (instancing
in effect), fine for desktop/mobile and workable on Quest for a static scene.

## Code map

- `src/main.js` — renderer, scene/atmosphere, rig+camera, render loop, stats.
- `src/modeswitcher.js` — Screen/VR/AR detection + session lifecycle (never stuck).
- `src/controls.js` — flat-mode look (hold-drag; opt-in pointer-lock / gyro). No locomotion yet.
- `src/room.js` — floor/walls/ceiling shell + green emissive strips. `ROOM` constants.
- `src/layout.js` — instanced pillars/beams/catwalk + scattered props + coin.
- `src/vault.js` — measures the vault hole by raycast, fits + parents the door, `openVault()/closeVault()` stubs. `DOOR_OFFSET/DOOR_SCALE/DOOR_ROTATION` constants.
- `src/postfx.js` — ACES tone mapping + restrained half-res bloom (flat mode only).

## Rigged for later prompts

- **Locomotion:** yaw lives on the rig, pitch on the camera — rig is forward-aware.
- **Vault open:** door is parented to the vault on a hinge group; call
  `window.__sat.vault.openVault()` to swing it (left at 0 / closed now).
- **Hiding spots:** props are placed as future colliders behind/under cover.

## Not verifiable headless

Real VR "Enter VR" on a Quest and AR passthrough on a phone — test on-device.
