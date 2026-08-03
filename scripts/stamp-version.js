// scripts/stamp-version.js
// Run before build to update public/version.json with the current timestamp
// (used by the app's auto-reload-on-new-deploy check — see pri-tod-v3.jsx) and
// the semver from package.json (used to display the app version — see
// docs/RELEASING.md for the bump-on-release step).
// Add to package.json: "build": "node scripts/stamp-version.js && vite build"
import { writeFileSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
const version = { v: Date.now().toString(), version: pkg.version };
writeFileSync(
  resolve(__dirname, "../public/version.json"),
  JSON.stringify(version)
);
console.log("[stamp-version] wrote version:", version.v, "app version:", version.version);
