// scripts/stamp-version.js
// Run before build to update public/version.json with current timestamp
// Add to package.json: "build": "node scripts/stamp-version.js && vite build"
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const version = { v: Date.now().toString() };
writeFileSync(
  resolve(__dirname, "../public/version.json"),
  JSON.stringify(version)
);
console.log("[stamp-version] wrote version:", version.v);
