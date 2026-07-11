// Palette previewer — prints every theme colour as a truecolor swatch.
// Run in a truecolor terminal:  bun run scripts/palette.ts
// Reads live from src/tui/theme.ts, so edit the palette and re-run to iterate.
import { palette, engineAccent } from "../src/tui/theme";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** A filled truecolor block of `width` cells. */
function swatch(hex: string, width = 16): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m${" ".repeat(width)}\x1b[0m`;
}

function row(name: string, hex: string, width = 16, note = ""): string {
  return `  ${name.padEnd(15)}${swatch(hex, width)}  ${hex}${note ? "   " + note : ""}`;
}

function compare(name: string, oldHex: string, newHex: string): string {
  return `  ${name.padEnd(15)}${swatch(oldHex, 10)} ${oldHex}   →   ${swatch(newHex, 10)} ${newHex}`;
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

console.log("\n\x1b[1mPrism Vesicle palette\x1b[0m \x1b[2m(live from src/tui/theme.ts)\x1b[0m\n");

section("SURFACES");
console.log(row("bg", palette.bg));
console.log(row("panelBorder", palette.panelBorder));
console.log(row("sectionBorder", palette.sectionBorder));

section("TEXT");
console.log(row("textPrimary", palette.textPrimary));
console.log(row("textSecondary", palette.textSecondary));
console.log(row("textMuted", palette.textMuted));
console.log(row("textDim", palette.textDim));

section("ROLE (message tags)");
console.log(row("user", palette.user));
console.log(row("assistant", palette.assistant));
console.log(row("system", palette.system));
console.log(row("tool", palette.tool));

section("LANES (message left bars)");
console.log(row("laneUser", palette.laneUser, 24));
console.log(row("laneAssistant", palette.laneAssistant, 24));
console.log(row("laneSystem", palette.laneSystem, 24));
console.log(row("laneTool", palette.laneTool, 24));

section("SEMANTIC");
console.log(row("error", palette.error));
console.log(row("success", palette.success));
console.log(row("warn", palette.warn));
console.log(row("gateAccent", palette.gateAccent));

section("BRAND");
console.log(row("brand", palette.brand));
console.log(row("brandDim", palette.brandDim));

section("ENGINE ACCENTS");
for (const engine of ["etl", "runtime", "evaluate", "weaver", "weaver-orch", "dyad"]) {
  console.log(row(engine, engineAccent(engine)));
}

section("LANE FIX PROPOSAL: old → new");
console.log(compare("system", "#c9a86a", palette.system));
console.log(compare("laneUser", "#3a7da8", palette.laneUser));
console.log(compare("laneAssistant", "#a8915a", palette.laneAssistant));
console.log(compare("laneSystem", "#8a7340", palette.laneSystem));
console.log();
