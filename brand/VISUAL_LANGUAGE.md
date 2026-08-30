# Prism Vesicle Visual Language

This is the version-controlled brand design language for Prism Vesicle. It fixes the aesthetic, concept, motif vocabulary, palette of record, motion grammar, terminal derivation rules, and anti-patterns. Every brand asset and in-app surface derives from it. The mark variants, ASCII scheme, and raster exports are catalogued in [`README.md`](./README.md); the live TUI palette and engine accents live in `src/tui/theme.ts`. Implementation state belongs in [`STATUS.md`](../STATUS.md) and the TUI contract in [`docs/dev/TUI.md`](../docs/dev/TUI.md); this document records the durable language, not shipping progress.

## Soul

**A refractive CRT-phosphor terminal.** A translucent vesicle holds a glass prism; an emerald beam enters through a pore in the membrane, refracts, and leaves as a soft spectrum. Light is the subject — volume, Fresnel rim, phosphor glow, caustics — not a line diagram of light. Calm, precise, never loud.

## Aesthetic Anchors

Every design decision aligns to these. When they conflict, the higher one wins; the first is the highest.

1. **Calm, never loud.** Prefer quiet restraint over spectacle. Never compete for attention.
2. **Light is the subject, not the lines.** Show light itself — glow, volume, depth, Fresnel edges, air — rather than diagramming its path with straight segments.
3. **Slow, physical motion.** Light drifts, shadows grade, edges breathe on a seconds-scale. No spring, jitter, or fast flash.
4. **Instrument/terminal feel.** Like an optical bench or an old oscilloscope, not a consumer app.
5. **Reject the generic AI/SaaS look.** No flat line icons, no flowchart topologies, no neon cyberpunk, no cheerful rainbow gradients.

## Concept

- **Prism** — the refracting element. One (emerald) beam enters and splits into a spectrum.
- **Vesicle** — the translucent vessel holding the prism; light enters one pore and exits another as a spectrum.
- **Spectrum** — the refracted band, mapping to the product's engine spectrum.
- **Traveling light** — a moving light source or spot. It is what makes the mark feel alive; even a still frame should imply light in motion.

The narrative: a beam enters the vesicle, is refracted by the prism, and emerges as a spectrum. This is the product metaphor — input decomposed, reconstructed, and output by the engines.

## Motif Vocabulary

These motifs form the visual grammar. A primary brand visual carries the soul of at least the first four, not just their silhouette.

| Motif | Meaning |
|---|---|
| Phosphor glow | edge Fresnel, thin per-object/per-glyph glow (never blooming) |
| Prism refraction | the instant a beam becomes a multi-hue spectrum |
| Blueprint grid | a very faint technical-drawing grid as optional ground |
| Glass + caustics | translucent layers plus light-trace/caustic rings |
| Vesicle vessel | a punctured translucent membrane or shell |
| Terminal vocabulary | prompt line, cursor, `❯` marker (UI only, not part of the logo) |

## Palette Of Record

Use exactly these hues; do not substitute.

**Brand beam and grounds**

- Emerald (primary) `#10b981` — deep `#047857`, bright `#34d399`
- Amber `#d97706` — the one sanctioned state/gate accent
- Violet `#7c3aed` — restrained Fresnel-rim accent
- Dark ground: brand-mark ground `#0d1110`; TUI surface is a near-zero-chroma neutral graphite (`#121415`, hue ≈ 200°, chroma ≤ 8%) so warm casts do not read dirty in dense character UI
- Light ground: warm off-white `#f5f4f0` — **never pure white** (emerald reads as cheap green on pure white)

**Engine refraction spectrum** (the beam splits into one hue per engine; `src/tui/theme.ts` `engineAccent` is the source of truth, deepened and softened on the light ground):

| Engine | Hue |
|---|---|
| ETL | emerald `#10b981` (the incident beam itself) |
| Runtime | cyan `#22d3ee` |
| Evaluate | yellow `#facc15` |
| Weaver | orange `#fb923c` |
| Weaver-Orch | rose `#f43f5e` |
| Dyad | magenta `#e879f9` |
| Stage | violet `#8b5cf6` (the locked palette's last unused hue; keeps stage off evaluate's warm gold) |

## Motion Grammar

When motion is delivered, accept only **slow, continuous, physically grounded** movement.

- Light orbits or drifts; beam micro-drift; Fresnel edge breathing.
- Displacement cycles on an **8–15 second** scale — very slow.
- Easing uses **only `linear` and `steps`**. `cubic-bezier` and spring physics are forbidden.
- A static primary visual must still imply live light (asymmetry of highlight position and shadow direction).
- Honor reduced motion: `VESICLE_REDUCED_MOTION=1` freezes every animated state to a static frame.

## Terminal Derivation

Vesicle runs on the self-maintained OpenTUI fork (@3akhp/opentui-core, upstream v0.5.3 base) with Solid. The terminal probes but does **not** emit Kitty/Sixel/OSC1337 raster protocols, so a bitmap logo cannot render inline in the terminal. In-app marks (startup splash, empty-session hero, header) are therefore **ANSI character art derived from the brand mark**: rasterize the SVG, map luminance through the ` .:-=+*#%@` ramp with a floor at the ground colour, apply the locked palette, and respect the ~1:2 terminal cell aspect. Re-derive after any SVG change. Bitmaps are used only outside the terminal (README, social preview, npm, installer). Windows distribution derivatives stay outside the terminal language: the canonical ICO uses the mono silhouette for small frames and the transparent compact mark for larger frames, while the Inno Setup wizard uses the compact mark on a transparent surface. These are deterministic raster derivatives, not new logo variants.

## Signature Moments In The TUI

The implemented TUI carries three signature surfaces, governed by this language and owned in detail by [`docs/dev/TUI.md`](../docs/dev/TUI.md):

- **Startup splash** — the ANSI prism-vesicle mark, `PRISM VESICLE` wordmark, and one slow traveling light along the membrane; degrades by terminal capability (animated → static quantized frame → frozen under reduced motion → skipped for non-interactive terminals) and never blocks startup.
- **Empty-session hero** — a quiet compact mark, tagline, and one entry hint in place of a bare ready notice, replaced by the real transcript on the first turn.
- **Static motif wiring** — a 1-cell per-message role spectrum lane (`laneUser`/`laneAssistant`/`laneSystem`/`laneTool`), the active engine's refraction accent on the header and turn markers (`engineAccent`), and a restrained `┌─ Title ─` ASCII-frame label on the sidebar's internal sections.

The working area below the composer stays static; continuous animation lives only in the splash.

## Anti-Patterns

| Do not | Reason |
|---|---|
| Flat line-art icons (pure-stroke outlines) | draws light as line segments, loses the soul |
| Flowchart / network-topology spectrum fans | reads as an AI-startup diagram |
| Generic SaaS / AI product chrome | the family this design rejects |
| Neon, cyberpunk, bloom, lens-flare abuse | violates calm restraint |
| Spring / jitter / fast-flash motion | violates slow physical motion |
| Mid-fidelity illustration (cluttered, gradient-dependent) | neither a good hero nor a good icon |

## Variants And Consistency

The mark has dark-ground, off-white-ground, transparent compact, single-colour silhouette, and animated variants (see [`README.md`](./README.md)). Use the transparent compact variant at roughly 64–128 px on neutral documentation surfaces, below ~32 px prefer the mono silhouette, and keep the full luminous variants for displays of roughly 128 px or larger. Do not recolour the beam, reorder the spectrum, add container shapes, place the full dark-ground mark on pure white, or render the beam or spectrum as hard line segments — the light is volumetric; that is the identity.
