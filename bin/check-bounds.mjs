#!/usr/bin/env node
// check-bounds.mjs — offline integrity sweep: every verified/falsified claim's
// announced bound must not exceed the domain its verification actually covered.
// Usage: node bin/check-bounds.mjs [campaignId…]   (no arg = all campaigns)
// Exit 1 when a mismatch is found that is NOT flagged in state.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.RESEARCH_HOME ?? path.join(ROOT, "workspaces");

const SUPERS = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };

function bracketInner(inner) {
  const trimmed = inner.trim();
  if (/^\d{1,4}\s*,\s*\d{1,7}$/.test(trimmed)) return trimmed.replace(/\s*,\s*/g, "|");
  if (/^\d{1,3}(,\d{3})+$/.test(trimmed)) return trimmed.replace(/,/g, "");
  return trimmed.split(/,\s+/).map((part) => part.replace(/,/g, "")).join("|");
}

function announcedBounds(text) {
  // ranges FIRST: "[1,500]" endpoints, not a thousands separator
  let t = text.replace(/[\[(]([^\)\]]*)[\])]/g, (_m, inner) => `|${bracketInner(String(inner))}|`);
  t = t.replace(/,/g, "").replace(/\s/g, "");
  t = t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => m.split("").map((c) => SUPERS[c]).join(""));
  const out = new Set();
  for (const m of t.matchAll(/(\d+)(?:\^|\*\*)(\d+)/g)) {
    if (m[1] === "10" && Number(m[2]) <= 30) out.add(10 ** Number(m[2]));
  }
  const cleaned = t.replace(/(\d+)(?:\^|\*\*)(\d+)/g, " ").replace(/\d+e\d+/g, (m) => {
    const [a, b] = m.split("e");
    const v = Number(a) * 10 ** Number(b);
    if (v >= 100) out.add(v);
    return " ";
  });
  for (const m of cleaned.matchAll(/\d{3,}/g)) {
    const n = Number(m[0]);
    if (n >= 100 && n < 1e15) out.add(n);
  }
  return [...out];
}

function coverageOf(domain) {
  return Math.max(...(domain.realCoverage ?? domain.variables).map((r) => r.max), 0);
}

const want = process.argv.slice(2).map((a) => (a.includes(":") ? a : `campaign:${a}`));
let findings = 0;
let checked = 0;

if (!existsSync(HOME)) {
  console.error(`no workspaces at ${HOME}`);
  process.exit(0);
}
for (const dir of readdirSync(HOME)) {
  if (!/^c_\d+-/.test(dir)) continue;
  const file = path.join(HOME, dir, "state", "events.jsonl");
  if (!existsSync(file)) continue;
  const cid = `campaign:${dir.split("-")[0]}`;
  if (want.length > 0 && !want.includes(cid)) continue;
  const claims = new Map();
  const verifs = new Map();
  const viaToTarget = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const p = e.payload ?? {};
    if (e.type === "object.created" && p.object?.type === "claim") claims.set(p.object.id, p.object);
    if (e.type === "claim.status_changed") {
      const c = claims.get(p.objectId);
      if (c) c.epistemicStatus = p.to;
      if (p.via) viaToTarget.set(p.via, p.objectId);
    }
    if (e.type === "claim.flagged") {
      const c = claims.get(p.objectId);
      if (c) c.flaggedBound = true;
    }
    if (e.type === "verification.passed") verifs.set(p.verificationId, p);
  }
  for (const [vid, v] of verifs) {
    const domain = v.verifiedDomain;
    if (!domain || domain.mode !== "exhaustive") continue;
    if (!(v.appliedTransitions ?? []).length) continue;
    const targetId = viaToTarget.get(vid);
    if (!targetId) continue;
    const claim = claims.get(targetId);
    if (!claim || !["verified", "falsified"].includes(claim.epistemicStatus)) continue;
    checked++;
    const cov = coverageOf(domain);
    if (cov <= 0) continue;
    const nums = announcedBounds(`${claim.title} ${JSON.stringify(claim.content?.statement ?? "")}`).filter((n) => n >= 100);
    const bad = nums.filter((n) => n > cov * 1.5 + 10);
    if (bad.length > 0) {
      if (claim.flaggedBound) {
        console.log(`⚠  ${cid} ${targetId} flagged (ok): ${claim.title.slice(0, 70)} — announced ${bad.join(",")} vs ≤${cov}`);
      } else {
        console.log(`✗  ${cid} ${targetId} UNFLAGGED MISMATCH: ${claim.title.slice(0, 70)} — announced ${bad.join(",")} vs verified ≤${cov}`);
        findings++;
      }
    }
  }
}

console.log(`checked ${checked} exhaustive verifications across ${want.length ? want.join(",") : "all campaigns"}`);
if (findings > 0) {
  console.error(`${findings} unflagged bound mismatch(es)`);
  process.exit(1);
}
console.log("bounds OK");
