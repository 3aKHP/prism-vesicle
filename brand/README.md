# Prism Vesicle Brand Mark

One beam in, the spectrum out. A translucent vesicle holds a glass prism; an emerald beam enters through a pore in the membrane, refracts, and leaves as a soft spectrum. Light is the subject — volume, Fresnel rim, phosphor glow, caustics. Calm, precise, never loud.

The mark follows a fixed visual design language whose palette, motion grammar, and anti-patterns govern every variant. Palette of record:

- Emerald `#10b981` (deep `#047857`, bright `#34d399`) — the brand beam
- Engine spectrum `#22d3ee` `#facc15` `#fb923c` `#f43f5e` `#e879f9`
- Amber `#d97706` and violet `#7c3aed` — restrained Fresnel rim accents
- Dark ground `#0d1110`; light ground **off-white `#f5f4f0`, never pure white**

## Files

- `prism-vesicle.svg` — primary luminous mark on the dark ground. Radial volume + Fresnel rim + blurred volumetric light; needs an SVG renderer with `feGaussianBlur` support (all browsers, librsvg, resvg, cairosvg).
- `prism-vesicle-light.svg` — off-white variant. The Fresnel rim inverts to deep emerald and the beam deepens to `#047857`; the spectrum keeps the locked hues. Never place the dark variant on pure white.
- `prism-vesicle-mono.svg` — single-colour silhouette (`currentColor`): the membrane ring broken at the two pores, prism solid inside. For favicons, installer icons, engraving, and small sizes.
- `prism-vesicle-animated.svg` — motion variant. A light spot travels the membrane (14 s), the lit rim breathes (12 s), the beam drifts (10 s); linear easing only, and `prefers-reduced-motion` holds the static frame. Animation is CSS inside the SVG, so it plays in browsers and stays still in rasterisers.
- `exports/prism-vesicle-1024-dark.png`, `exports/prism-vesicle-1024-light.png` — 1024×1024 raster exports of the two grounds.
- `prism-vesicle.ascii.txt` — terminal character-art scheme: a 56-column phosphor splash and a 24-column compact mark, derived from the actual renders through a luminance ramp (` .:-=+*#%@`), plus the ANSI colour layer. Pure 7-bit ASCII.

## Usage

- Silhouette stays legible at small sizes; below 32 px prefer the mono silhouette. The luminous variants need roughly 128 px to keep the spectrum.
- Do not recolour the beam, reorder the spectrum, add container shapes, or place the mark on pure white. Do not render the beam/spectrum as hard line segments — the light is volumetric; that is the identity.
- The ASCII marks are derived, not hand-drawn: rasterise the SVG, map luminance through the ramp with a floor at the ground colour, and respect the ~1:2 terminal cell aspect. Re-derive after any SVG change.
