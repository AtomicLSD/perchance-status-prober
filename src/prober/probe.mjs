#!/usr/bin/env node
// External 24/7 prober for the Perchance Status Monitor.
//
// The page can only measure uptime while a tab is open (even in the background,
// browsers throttle timers). This small Node script probes the same HTTP
// endpoints the page probes, folds each run into rolling buckets, and writes a
// JSON feed the page ingests to fill the minutes nobody was watching.
//
// It intentionally skips the two checks that are only possible inside a real
// browser — `aigen` (a live text-generation call) and `kv` (an actual IndexedDB
// roundtrip). The page's coverage metric excludes those too, so the numbers line
// up: the prober covers exactly the externally-observable surface.
//
// Usage:
//   node probe.mjs <store.json>
//
// Environment:
//   PROBER_NAME          label shown on the page           (default "external")
//   PROBER_REGION         location label                    (default "")
//   PROBER_INTERVAL_SEC   seconds between runs, for the page (default 300)
//
// The feed schema is the same one index.html's external-feed section consumes
// (see src/prober/README.md for the full contract):
//   { kind, v, prober, region, generatedAt, intervalSec,
//     b: { key: [ {m,n,ok,sum,max} ] },   // 1-minute buckets, last 24h
//     h: { key: [ {m,n,ok,sum,max} ] },   // hourly rollups,  last 7d
//     d: { key: [ {m,n,ok,sum,max} ] } }  // daily rollups,   last 120d
//   bucket.m is the bucket start (ms); n counts probes; ok counts responses
//   received (a reachable 5xx still counts here, exactly like the page's
//   recordProbe); sum/max are latency sum and peak. Re-running adds one more
//   sample to the current minute, so the file is cumulative, not a one-shot.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const BUCKET_MS = 60000;
export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;
export const KEEP_B = 1440; // 24h of minutes
export const KEEP_H = 168;  // 7d of hours
export const KEEP_D = 120;  // 120d of daily rollups

// Mirrors `psServices` in index.html. `expect` is the status a healthy service
// returns (some endpoints answer 400/404 by design when probed bare) and is used
// only for logging; the page compares against its own copy.
export const ENDPOINTS = [
  { key: "home",     url: "https://perchance.org/",                                                          expect: 200 },
  { key: "upload",   url: "https://upload.perchance.org/embed",                                              expect: 200 },
  { key: "filehost", url: "https://user.uploads.dev",                                                        expect: 400 },
  { key: "editable", url: "https://editable.uploads.dev",                                                    expect: 404 },
  { key: "aiplugin", url: "https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=ai-text-plugin",         expect: 200 },
  { key: "t2i",      url: "https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=text-to-image-plugin",   expect: 200 },
  { key: "server",   url: "https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=server-plugin",          expect: 200 },
  { key: "comments", url: "https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=comments-plugin",        expect: 200 },
  { key: "stats",    url: "https://perchance.org/api/getGeneratorStats?generatorName=animal",                 expect: 200 },
  { key: "search",   url: "https://perchance.org/search?q=cat",                                              expect: 200 },
];

const TIMEOUT_MS = 15000;

function bucketStart(t, size) { return Math.floor(t / size) * size; }

// Fold one probe into a bucket store, appending to the newest bucket if it is
// for the same period (same contract as the page's histAdd).
export function fold(store, key, m, reached, ms, keep) {
  const arr = store[key] || (store[key] = []);
  let b = arr.length ? arr[arr.length - 1] : null;
  if (!b || b.m !== m) {
    b = { m: m, n: 0, ok: 0, sum: 0, max: 0 };
    arr.push(b);
  }
  b.n++;
  if (reached) {
    b.ok++;
    b.sum += ms;
    if (ms > b.max) b.max = ms;
  }
  if (arr.length > keep) arr.splice(0, arr.length - keep);
}

export function prune(store, keep) {
  Object.keys(store).forEach((k) => {
    const arr = store[k];
    if (Array.isArray(arr) && arr.length > keep) arr.splice(0, arr.length - keep);
  });
}

// One HTTP probe. Reachability (a response of any status) is what the buckets
// record; classification (down / degraded / ok) drives the log line only, and
// mirrors classifyObserved() on the page.
export async function probeOne(ep) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ep.timeoutMs || TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(ep.url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "perchance-status-prober/1 (+https://perchance.org/server-status)" },
    });
    // Drain the body so the timing reflects a complete response, not just headers.
    await res.arrayBuffer().catch(() => {});
    return { reachable: true, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { reachable: false, error: e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

export function classify(r) {
  if (!r.reachable) return "down";
  if (r.status >= 500) return "degraded";
  return "ok";
}

export async function run(store, opts = {}) {
  const now = opts.now || Date.now();
  const mb = bucketStart(now, BUCKET_MS);
  const hb = bucketStart(now, HOUR_MS);
  const db = bucketStart(now, DAY_MS);
  const results = [];
  for (const ep of ENDPOINTS) {
    const r = await probeOne(ep);
    const ms = r.reachable ? r.ms : null;
    const state = classify(r);
    fold(store.b, ep.key, mb, r.reachable, r.ms || 0, KEEP_B);
    fold(store.h, ep.key, hb, r.reachable, r.ms || 0, KEEP_H);
    fold(store.d, ep.key, db, r.reachable, r.ms || 0, KEEP_D);
    results.push({ key: ep.key, state, status: r.reachable ? r.status : null, ms, error: r.error || null });
  }
  prune(store.b, KEEP_B);
  prune(store.h, KEEP_H);
  prune(store.d, KEEP_D);
  return results;
}

export function emptyStore() { return { b: {}, h: {}, d: {} }; }

export function loadStore(path) {
  const store = emptyStore();
  try {
    const prev = JSON.parse(readFileSync(path, "utf8"));
    for (const k of ["b", "h", "d"]) {
      if (prev && prev[k] && typeof prev[k] === "object") store[k] = prev[k];
    }
  } catch (e) { /* first run, or unreadable file — start fresh */ }
  return store;
}

export function buildFeed(store, opts = {}) {
  return {
    kind: "perchance-status-probes",
    v: 1,
    prober: opts.prober || "external",
    region: opts.region || "",
    generatedAt: opts.now || Date.now(),
    intervalSec: opts.intervalSec || 300,
    b: store.b,
    h: store.h,
    d: store.d,
  };
}

async function main() {
  const outPath = process.argv[2] || "probes.json";
  const store = loadStore(outPath);
  const results = await run(store);
  const feed = buildFeed(store, {
    prober: process.env.PROBER_NAME || "external",
    region: process.env.PROBER_REGION || "",
    intervalSec: Number(process.env.PROBER_INTERVAL_SEC) || 300,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(feed));
  const bytes = Buffer.byteLength(JSON.stringify(feed));
  const down = results.filter((r) => r.state === "down").length;
  const degraded = results.filter((r) => r.state === "degraded").length;
  console.log(`[prober] ${results.length} probes — ${results.length - down - degraded} ok, ${degraded} degraded, ${down} down (${bytes} bytes) -> ${outPath}`);
  results.forEach((r) => console.log(`  ${r.state === "ok" ? "OK  " : r.state === "degraded" ? "DEGR" : "DOWN"} ${r.key.padEnd(9)} ${r.ms}ms${r.error ? " " + r.error : ""} (HTTP ${r.status})`));
  // Always exit 0: the recorded data — including outages — is the product.
}

main().catch((e) => { console.error("[prober] fatal:", e); process.exit(1); });
