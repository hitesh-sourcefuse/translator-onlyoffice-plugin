// Rasterises the plugin icons from SVG.
//
// ONLYOFFICE asks for three unrelated sets:
//
//   plugin list   small square icon, 28px base
//   store card    wide 120x60 banner shown above the plugin name
//   toolbar       one icon per toolbar button, 28px base, under
//                 resources/icons/<theme>/big/
//
// All are needed at five display scales, and all must keep their
// transparency — a baked-in white background shows up as a white block on the
// store card and on the dark theme.
//
// Toolbar icons are line art, so they need to invert between themes. The
// source SVGs carry a {{FG}} token that is substituted per theme rather than
// being drawn twice.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Scale suffix → multiplier. The base size is the 1x entry.
const SCALES = [
    ["", 1],
    ["@1.25x", 1.25],
    ["@1.5x", 1.5],
    ["@1.75x", 1.75],
    ["@2x", 2],
];

// Ink colour for toolbar line art, per editor theme.
const THEME_FOREGROUND = { light: "#444444", dark: "#d8d8d8" };

const TOOLBAR_ICONS = ["translate", "sync", "settings", "history"];

function render(svg, width, outDir, basename) {
    mkdirSync(outDir, { recursive: true });
    for (const [suffix, multiplier] of SCALES) {
        const png = new Resvg(svg, {
            fitTo: { mode: "width", value: Math.round(width * multiplier) },
        })
            .render()
            .asPng();
        writeFileSync(resolve(outDir, `${basename}${suffix}.png`), png);
    }
}

// --- Plugin list icon and store card banner ---

const APP_ICONS = [
    { svg: "assets/icon.svg", out: "static/resources/light", width: 28 },
    { svg: "assets/icon.svg", out: "static/resources/dark", width: 28 },
    {
        svg: "assets/icon-store.svg",
        out: "static/resources/store/icons",
        width: 120,
    },
];

for (const target of APP_ICONS) {
    const svg = readFileSync(resolve(root, target.svg));
    const outDir = resolve(root, target.out);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "icon.svg"), svg);
    render(svg, target.width, outDir, "icon");
    console.log(`✓ ${target.out} (${target.width}px base)`);
}

// --- Toolbar button icons ---

for (const [theme, foreground] of Object.entries(THEME_FOREGROUND)) {
    const outDir = resolve(root, `static/resources/icons/${theme}/big`);
    mkdirSync(outDir, { recursive: true });
    for (const name of TOOLBAR_ICONS) {
        const source = readFileSync(
            resolve(root, `assets/toolbar/${name}.svg`),
            "utf8",
        );
        const svg = source.replaceAll("{{FG}}", foreground);
        writeFileSync(resolve(outDir, `${name}.svg`), svg);
        render(svg, 28, outDir, name);
    }
    console.log(
        `✓ static/resources/icons/${theme}/big (${TOOLBAR_ICONS.length} icons)`,
    );
}
