import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const distDir = resolve(root, "dist");
const pluginFile = resolve(root, "translator-plugin.plugin");

if (!existsSync(distDir)) {
    console.error("Error: dist/ not found. Run 'npm run build' first.");
    process.exit(1);
}

if (existsSync(pluginFile)) {
    rmSync(pluginFile);
}

execSync(`cd "${distDir}" && zip -r "${pluginFile}" .`, { stdio: "inherit" });

console.log("\n✅ Created: translator-plugin.plugin");
