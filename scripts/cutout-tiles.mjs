// cutout-tiles.mjs — background-remove the 18 raw tiles → transparent PNGs.
// Replicate lucataco/remove-bg (rembg). Reads REPLICATE_API_TOKEN from
// ../crucible-asset-studio/.env.local. Triple-gated like gen-tiles.
//
//   node scripts/cutout-tiles.mjs                       # dry-run
//   node scripts/cutout-tiles.mjs --paid --confirm --cap 0.50
//
// In:  public/tiles-src/w{w}_k{k}.png   Out: public/tiles-cut/w{w}_k{k}.png
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const IN = path.join(ROOT, "public", "tiles-src");
const OUT = path.join(ROOT, "public", "tiles-cut");
const MODEL = "lucataco/remove-bg";
// Community models need the version-hash form (POST /v1/predictions), not the
// /models/{owner}/{name}/predictions endpoint (that's official-models only).
const MODEL_VERSION = "95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1";
const COST_PER = 0.003;

const args = process.argv.slice(2);
const paid = args.includes("--paid");
const confirm = args.includes("--confirm");
const capIdx = args.indexOf("--cap");
const cap = capIdx >= 0 ? Number(args[capIdx + 1]) : 1.0;

function readToken() {
  if (process.env.REPLICATE_API_TOKEN) return process.env.REPLICATE_API_TOKEN;
  const p = path.resolve(ROOT, "..", "crucible-asset-studio", ".env.local");
  if (existsSync(p)) {
    const m = readFileSync(p, "utf8").match(/^REPLICATE_API_TOKEN=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const files = existsSync(IN) ? readdirSync(IN).filter((f) => f.endsWith(".png")) : [];
const est = files.length * COST_PER;

if (!paid) {
  console.log(`DRY-RUN — bg-remove ${files.length} tiles, est ~$${est.toFixed(3)} (${MODEL})`);
  console.log(`Token: ${readToken() ? "found" : "MISSING"}`);
  console.log(`Run: node scripts/cutout-tiles.mjs --paid --confirm --cap ${Math.max(cap, est).toFixed(2)}`);
  process.exit(0);
}

const token = readToken();
if (!token) { console.error("No REPLICATE_API_TOKEN."); process.exit(1); }
if (est > cap) { console.error(`Est $${est.toFixed(3)} > cap $${cap.toFixed(2)}.`); process.exit(1); }
if (!confirm) { console.error(`Add --confirm (spends ~$${est.toFixed(3)}).`); process.exit(1); }

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cut(file) {
  const dataUri = "data:image/png;base64," + readFileSync(path.join(IN, file)).toString("base64");
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
      body: JSON.stringify({ version: MODEL_VERSION, input: { image: dataUri } }),
    });
    if (res.status === 429) {
      // throttle only (not charged) — back off and retry.
      const body = await res.json().catch(() => ({}));
      await sleep((body.retry_after ?? 5) * 1000 + 500);
      continue;
    }
    if (!res.ok) throw new Error(`${file}: ${res.status} ${await res.text()}`);
    let data = await res.json();
    // Poll until terminal if Prefer:wait returned it still processing.
    const getUrl = data.urls?.get;
    while (data.status && data.status !== "succeeded" && data.status !== "failed" && getUrl) {
      await sleep(1200);
      data = await (await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } })).json();
    }
    if (data.status === "failed") throw new Error(`${file}: prediction failed ${data.error ?? ""}`);
    const url = Array.isArray(data.output) ? data.output[0] : data.output;
    if (!url) throw new Error(`${file}: no output (status ${data.status})`);
    const png = Buffer.from(await (await fetch(url)).arrayBuffer());
    writeFileSync(path.join(OUT, file), png);
    console.log(`  ✓ ${file} (${(png.length / 1024) | 0} KB)`);
    return;
  }
  throw new Error(`${file}: gave up after retries`);
}

console.log(`PAID — bg-removing ${files.length} tiles (~$${est.toFixed(3)}) → ${OUT}`);
let ok = 0;
for (const f of files.sort()) {
  if (existsSync(path.join(OUT, f))) { ok++; continue; } // resume
  try {
    await cut(f);
    ok++;
    await sleep(1500); // pace under the 5-burst / 60-per-min limit
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
  }
}
console.log(`\nDone: ${ok}/${files.length}. Next: autocrop + normalize-scale + pack.`);
