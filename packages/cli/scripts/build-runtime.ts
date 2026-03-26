import { loadHyperframeRuntimeSource } from "@hyperframes/core";
import { copyFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreDistDir = resolve(__dirname, "../../core/dist");

// Write runtime source (keep legacy name for backward compat)
const runtimeSource = loadHyperframeRuntimeSource();
writeFileSync("dist/hyperframe-runtime.js", runtimeSource);

// Copy manifest + runtime with canonical names so hyperframeRuntimeLoader's
// sibling-path resolution works in the bundled CLI (installed via npx).
copyFileSync(resolve(coreDistDir, "hyperframe.manifest.json"), "dist/hyperframe.manifest.json");
writeFileSync("dist/hyperframe.runtime.iife.js", runtimeSource);
