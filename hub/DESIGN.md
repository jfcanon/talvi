## Hub design contract (v9.0)

Canonical version for `hub/src/scene/` and `hub/src/ui/` source headers is **v9.0**. Older stamps (`v4.1`, `v8.0`) are stale. `scripts/build-assets.mjs` fails the build if a header or inline stamp drifts.

Live surface: `https://app.ygdcbtmc4u.uk` — orbit/dolly WebGL constellation, not a scroll-path of instrument panels. The frozen style study in `3d/` is a separate host.

### Palette (scene)

Dark cube bodies, one teal/mint phosphor voice. Magenta/cyan are **not** used in `hub/src/scene/` (fault-only in the original spec; they remain CSS tokens for sign-in/error chrome, not the world).

| Role | Value | Where |
| --- | --- | --- |
| Cube body | `0x121a22` | `world.js` `MeshStandardMaterial.color` |
| Cube emissive | `0x061410` | `world.js` |
| Phosphor glow | `0x7dffc4` | tile glow, pole star, rain |
| Cube edge | `0x4a7a68` | wireframe overlay |
| Sky / fog | `0x0a0a0c` | `world.js` / `main.js` |
| Phosphor (CSS) | `#7dffc4` / `#35d998` | `style.css` `--phosphor` |

### Glyphs

Four app cubes plus a dim future slot. `build-assets.mjs` already freezes the four app glyphs as bytes (`▣ ▤ ◈ ◆`); do not replace them with lookalikes.

| Glyph | App | Blade label |
| --- | --- | --- |
| ▣ | relay | RELAY |
| ▤ | chat | CHAT |
| ◈ | cinto | CINTO |
| ◆ | learn | LEARN |
| ＋ | future (no href) | MORE |

Layout is those four apps plus the MORE slot — not a fifth product cube.

### Layout

- 2×2-ish floating tiles in open deep space (no floor). Orbit/dolly camera around `FOCAL`; raycast click opens an app.
- Blade is the keyboard path (RELAY / CHAT / CINTO / LEARN / MORE). No DOM app labels on the cubes.
- To add an app: one row in `hub/src/ui/hubpage.js` `APPS` and a matching `TILE_CFG` entry in `hub/src/scene/world.js`.
