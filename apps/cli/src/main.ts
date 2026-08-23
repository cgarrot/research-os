#!/usr/bin/env node
// main.ts — the `research` CLI (spec §56 subset).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { CampaignSpec } from "@research-os/contracts";

const BASE = process.env.RESEARCH_URL ?? "http://127.0.0.1:8787";

async function api(method: string, p: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg = typeof json === "object" && json && "error" in json ? String((json as Record<string, unknown>).error) : text.slice(0, 300);
    throw new Error(`${res.status}: ${msg}`);
  }
  return json;
}

function print(v: unknown): void {
  if (typeof v === "string") console.log(v);
  else console.log(JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "doctor": {
      const health = (await api("GET", "/v1/health")) as Record<string, unknown>;
      const mesh = (await api("GET", "/v1/mesh/status")) as Record<string, unknown>;
      print({ researchd: health, mesh });
      break;
    }
    case "campaign": {
      const sub = args[0];
      if (sub === "create") {
        const file = args[1];
        if (!file || !existsSync(file)) throw new Error(`campaign file not found: ${file}`);
        const spec = parse(readFileSync(file, "utf8")) as { campaign: CampaignSpec };
        const out = (await api("POST", "/v1/campaigns", { spec: spec.campaign })) as { id: string; workspace: string };
        print(out);
        console.error(`\nnext: research campaign start ${out.id}`);
      } else if (sub === "start" || sub === "pause" || sub === "resume" || sub === "stop") {
        const id = normalizeId(args[1]);
        print(await api("POST", `/v1/campaigns/${id}/${sub}`));
      } else if (sub === "status") {
        print(await api("GET", `/v1/campaigns/${normalizeId(args[1])}`));
      } else if (sub === "list") {
        print(await api("GET", "/v1/campaigns"));
      } else if (sub === "report") {
        const md = await api("GET", `/v1/campaigns/${normalizeId(args[1])}/report`);
        console.log(md);
      } else if (sub === "events") {
        const out = (await api("GET", `/v1/campaigns/${normalizeId(args[1])}/events?limit=${args[2] ?? 50}`)) as unknown[];
        for (const ev of out) {
          const e = ev as Record<string, unknown>;
          console.log(`${String(e.timestamp).slice(11, 19)} ${String(e.type).padEnd(28)} ${String((e.actor as Record<string, unknown> | undefined)?.id ?? "")} ${JSON.stringify(e.payload).slice(0, 120)}`);
        }
      } else {
        print(await api("GET", "/v1/campaigns"));
      }
      break;
    }
    case "branch": {
      const id = normalizeId(args[1] ?? args[0]);
      print(await api("GET", `/v1/campaigns/${id}/branches`));
      break;
    }
    case "task": {
      const id = normalizeId(args[1] ?? args[0]);
      const tasks = (await api("GET", `/v1/campaigns/${id}/tasks${args.includes("--all") ? "" : ""}`)) as Record<string, unknown>[];
      for (const t of tasks) {
        console.log(`${String(t.id).padEnd(16)} ${String(t.status).padEnd(10)} r${String(t.round)} ${String(t.phase).padEnd(11)} ${String(t.role).padEnd(16)} ${String(t.goal).slice(0, 80)}`);
      }
      break;
    }
    case "object": {
      print(await api("GET", `/v1/objects/${encodeURIComponent(args[0] ?? "")}`));
      break;
    }
    case "graph": {
      print(await api("GET", `/v1/graph/expand?id=${encodeURIComponent(args[1] ?? args[0] ?? "")}&depth=2`));
      break;
    }
    case "worker": {
      const id = normalizeId(args[1] ?? args[0]);
      print(await api("GET", `/v1/campaigns/${id}/workers`));
      break;
    }
    case "review": {
      const id = normalizeId(args[1] ?? args[0]);
      const out = (await api("GET", `/v1/campaigns/${id}/review`)) as { campaignId: string; status: string; candidates: unknown[]; lessons: unknown[]; recentVerifications: unknown[] };
      console.log(`=== HUMAN REVIEW — ${out.campaignId} (${out.status}) ===`);
      console.log(`\nCandidates (${out.candidates.length}):`);
      for (const c of out.candidates as { id: string; content: { candidateType?: string; statement?: string; promotionStatus?: string; correctnessStatus?: string; noveltyStatus?: string } }[]) {
        console.log(`  ${c.id} [${c.content.promotionStatus ?? "?"}] ${c.content.candidateType ?? "?"}: ${String(c.content.statement ?? "").slice(0, 90)}`);
        console.log(`      correctness=${c.content.correctnessStatus ?? "?"} novelty=${c.content.noveltyStatus ?? "?"}`);
      }
      console.log(`\nDistilled lessons (${(out.lessons as unknown[]).length}):`);
      for (const l of out.lessons as { kind: string; statement: string }[]) {
        console.log(`  [${l.kind}] ${l.statement.slice(0, 110)}`);
      }
      console.log(`\nRecent verifications:`);
      for (const v of out.recentVerifications as { id: string; verifier: string; target: string }[]) {
        console.log(`  ${v.id} ${v.verifier} on ${v.target}`);
      }
      console.log(`\nActions: research decide ${id} accept|reject <subjectId> — research decide ${id} note "text"`);
      break;
    }
    case "decide": {
      const id = normalizeId(args[1] ?? args[0]);
      const decision = args[2];
      const subjectId = decision === "note" ? undefined : args[3];
      const note = decision === "note" ? args.slice(3).join(" ") : undefined;
      if (!decision || (decision !== "note" && !subjectId)) {
        console.error("usage: research decide <campaign> accept|reject <subjectId> | note <text>");
        break;
      }
      const out = await api("POST", "/v1/review/decision", { campaignId: id, decision, subjectId, note });
      print(out);
      break;
    }
    case "frontier": {
      print(await api("GET", `/v1/campaigns/${normalizeId(args[1] ?? args[0])}/frontier`));
      break;
    }
    case "queue": {
      // queue status: supervisor ledger + live campaign list
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      const qFile = process.env.RESEARCH_QUEUE_STATE ?? pathMod.join(process.env.RESEARCH_HOME ?? pathMod.join(process.cwd(), "workspaces"), "queue.json");
      let ledger: unknown = null;
      try {
        ledger = JSON.parse(fs.readFileSync(qFile, "utf8"));
      } catch {
        ledger = { note: `no queue ledger at ${qFile}` };
      }
      const campaigns = (await api("GET", "/v1/campaigns")) as { id: string; status: string; title: string }[];
      print({ ledger, campaigns: campaigns.map((c) => ({ id: c.id, status: c.status, title: c.title.slice(0, 60) })) });
      break;
    }
    case "watch": {
      const id = normalizeId(args[1] ?? args[0]);
      for (;;) {
        console.log(`\u001b[2J\u001b[H`);
        const st = (await api("GET", `/v1/campaigns/${id}`)) as Record<string, unknown>;
        const fr = (await api("GET", `/v1/campaigns/${id}/frontier`)) as Record<string, unknown>;
        console.log(`== ${String(st.title).slice(0, 70)} — ${String(st.status)} round ${String(st.round)} ==`);
        console.log(`verified: ${(fr.verifiedLemmas as string[] | undefined)?.length ?? 0} | falsified: ${(fr.falsifiedStatements as string[] | undefined)?.length ?? 0} | queued: ${JSON.stringify(fr.queuedByRole ?? {})} | tokens: ${JSON.stringify((fr.budgets as Record<string, unknown>)?.consumed ?? {})}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    case "verify": {
      // research verify <campaignId> <objectId> <verifierId> '<inputJson>'
      const [, target, verifier, inputJson] = args;
      const out = await api("POST", "/v1/verifications", {
        campaignId: normalizeId(args[0]),
        targetId: target,
        verifierId: verifier,
        requestedBy: "operator",
        input: inputJson ? JSON.parse(inputJson) : {},
      });
      print(out);
      break;
    }
    default: {
      console.log(`ResearchOS CLI v0.1

usage:
  research doctor
  research campaign create <file.yaml>
  research campaign list
  research campaign status <id>
  research campaign start|pause|resume|stop <id>
  research campaign report <id>
  research campaign events <id> [limit]
  research branch <id>            list branches
  research task <id>              list tasks
  research worker <id>            list agent runs
  research object <ref>           show object (e.g. hypothesis:h_3)
  research graph <id> <ref>       expand graph around ref
  research verify <id> <objRef> <verifierId> '<inputJson>'

env: RESEARCH_URL (default ${BASE})`);
      break;
    }
  }
}

function normalizeId(id: string | undefined): string {
  if (!id) throw new Error("campaign id required");
  return id.includes(":") ? id.replace("campaign:", "") : id;
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
