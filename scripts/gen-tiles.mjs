// gen-tiles.mjs — generate Cascade's 18 tile sprites via Replicate FLUX (schnell),
// direct REST, no Supabase/dev-server. Reads REPLICATE_API_TOKEN from
// ../crucible-asset-studio/.env.local (or the environment).
//
//   node scripts/gen-tiles.mjs                 # DRY-RUN: print prompts + cost, $0
//   node scripts/gen-tiles.mjs --paid          # REAL spend (needs the token + --confirm)
//   node scripts/gen-tiles.mjs --paid --confirm --cap 0.30
//
// Output: public/tiles-src/w{world}_k{kind}.png (raw, opaque). Background removal +
// atlas packing is a separate step (see docs/TILE-ART-BIBLE.md).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "public", "tiles-src");
const MODEL = "black-forest-labs/flux-schnell";
const COST_PER_IMAGE = 0.003; // USD, approx

const args = process.argv.slice(2);
const paid = args.includes("--paid");
const confirm = args.includes("--confirm");
const capIdx = args.indexOf("--cap");
const cap = capIdx >= 0 ? Number(args[capIdx + 1]) : 1.0;

// ── token (from crucible .env.local or env) ─────────────────────────────────
function readToken() {
  if (process.env.REPLICATE_API_TOKEN) return process.env.REPLICATE_API_TOKEN;
  const envPath = path.resolve(ROOT, "..", "crucible-asset-studio", ".env.local");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^REPLICATE_API_TOKEN=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// ── the 18 prompts (6 kinds × 3 worlds), per docs/TILE-ART-BIBLE.md ─────────
const KINDS = [
  { k: 0, motif: "faceted diamond gem" },
  { k: 1, motif: "leaf" },
  { k: 2, motif: "water droplet" },
  { k: 3, motif: "five-point star" },
  { k: 4, motif: "hexagonal cut stone" },
  { k: 5, motif: "blossom flower" },
];
const WORLDS = [
  { w: 0, mood: "soft gentle organic", palette: "fresh greens and warm gold" },
  { w: 1, mood: "warm fiery dusk, chunky", palette: "ember orange, red and amber" },
  { w: 2, mood: "cosmic luminous", palette: "cool purple, magenta and cyan" },
];
const prompt = (motif, mood, palette) =>
  `A single ${motif} game tile icon, ${mood} style, ${palette} colours, centered on a plain flat black background, bold clean silhouette, soft inner shading, glossy mobile match-3 gem art, no text, no scene, no drop shadow`;

const jobs = [];
for (const world of WORLDS)
  for (const kind of KINDS)
    jobs.push({ id: `w${world.w}_k${kind.k}`, prompt: prompt(kind.motif, world.mood, world.palette) });

const estCost = jobs.length * COST_PER_IMAGE;

// ── dry-run ─────────────────────────────────────────────────────────────────
if (!paid) {
  console.log(`DRY-RUN — ${jobs.length} tiles, est ~$${estCost.toFixed(3)} (${MODEL})`);
  for (const j of jobs) console.log(`  ${j.id}: ${j.prompt}`);
  console.log(`\nToken: ${readToken() ? "found" : "MISSING (add REPLICATE_API_TOKEN to crucible .env.local)"}`);
  console.log(`Run for real: node scripts/gen-tiles.mjs --paid --confirm --cap ${Math.max(cap, estCost).toFixed(2)}`);
  process.exit(0);
}

// ── paid run ────────────────────────────────────────────────────────────────
const token = readToken();
if (!token) {
  console.error("No REPLICATE_API_TOKEN (env or crucible/.env.local). Aborting.");
  process.exit(1);
}
if (estCost > cap) {
  console.error(`Estimated $${estCost.toFixed(3)} exceeds --cap $${cap.toFixed(2)}. Raise --cap or reduce jobs.`);
  process.exit(1);
}
if (!confirm) {
  console.error(`Refusing to spend without --confirm. This will cost ~$${estCost.toFixed(3)}.`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
async function generate(j) {
  const res = await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
    body: JSON.stringify({
      input: { prompt: j.prompt, aspect_ratio: "1:1", num_outputs: 1, output_format: "png", megapixels: "1", go_fast: true },
    }),
  });
  if (!res.ok) throw new Error(`${j.id}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const url = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!url) throw new Error(`${j.id}: no output url`);
  const png = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(path.join(OUT, `${j.id}.png`), png);
  console.log(`  ✓ ${j.id}.png (${(png.length / 1024).toFixed(0)} KB)`);
}

console.log(`PAID — generating ${jobs.length} tiles (~$${estCost.toFixed(3)}) → ${OUT}`);
let ok = 0;
for (const j of jobs) {
  try {
    await generate(j);
    ok++;
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
  }
}
console.log(`\nDone: ${ok}/${jobs.length} tiles. Next: background-remove + pack into public/tiles.png (see art-bible).`);
