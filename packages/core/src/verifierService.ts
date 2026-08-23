// verifierService.ts — deterministic exec verifier runner (spec §18).
// Only this path can transition claims to verified/falsified (invariant C).
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VerifierDefinition, VerificationRecord } from "@research-os/contracts";
import type { CampaignProjection, ResearchCore } from "./core.js";
import { registerArtifactBytes } from "./artifacts.js";
import { checkBoundConsistency, parseVerdict, verdictToDomain, type BoundCheck } from "./bounds.js";
import { nowIso, randHex } from "./util.js";

export interface VerificationOutcome {
  verification: VerificationRecord;
  artifactRef?: string;
  /** set when a strict bound mismatch refused the claim transition */
  boundRefused?: string;
}

/** Request + synchronously execute a verifier, then apply claim transitions. */
export async function runVerification(
  core: ResearchCore,
  proj: CampaignProjection,
  verifier: VerifierDefinition,
  input: { targetId: string; requestedBy: string; input: Record<string, unknown> },
): Promise<VerificationOutcome> {
  const target = proj.objects.get(input.targetId);
  if (!target) throw new Error(`verification target not found: ${input.targetId}`);

  const id = core.nextId(proj, "verification");
  const record: VerificationRecord = {
    id,
    campaignId: proj.state.id,
    targetId: input.targetId,
    verifierId: verifier.id,
    requestedBy: input.requestedBy,
    requestedAt: nowIso(),
    status: "pending",
  };
  core.apply(proj, "verification.requested", { kind: "worker", id: input.requestedBy }, { verification: record }, { correlationId: input.targetId });

  const sandbox = path.join(proj.stateDir, "sandbox", `${id}-${randHex(4)}`);
  mkdirSync(sandbox, { recursive: true });
  const inputFile = path.join(sandbox, "input.json");
  writeFileSync(inputFile, JSON.stringify(input.input ?? {}, null, 2));

  const cmd = verifier.command.map((part) =>
    part
      .replaceAll("{input_file}", inputFile)
      .replaceAll("{workspace}", proj.workspaceDir)
      .replaceAll("{campaign_dir}", proj.stateDir)
      .replaceAll("{script}", verifier.script ? path.resolve(verifier.moduleDir!, verifier.script) : inputFile),
  );

  const exec = await execCommand(cmd, {
    cwd: proj.workspaceDir,
    timeoutMs: verifier.timeoutSeconds * 1000,
  });

  const outputText = [
    `$ ${cmd.join(" ")}`,
    exec.stdout.trim(),
    exec.stderr.trim(),
    `exit code: ${exec.exitCode}${exec.timedOut ? " (timed out)" : ""}`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 64_000);

  const artifact = registerArtifactBytes(core, proj, Buffer.from(outputText, "utf8"), {
    logicalName: `verification-${id}.log`,
    mediaType: "text/plain",
    producer: `verifier:${verifier.id}`,
    branchId: target.branchId,
  });

  let status: VerificationRecord["status"];
  if (exec.timedOut) {
    status = "error";
  } else {
    status = (verifier.passExitCodes ?? [0]).includes(exec.exitCode) ? "passed" : "failed";
  }

  // claim transition — the ONLY path that may set verified/falsified
  const transitions: { from: string; to: string }[] = [];
  let boundCheck: BoundCheck | undefined;
  let domain: ReturnType<typeof verdictToDomain> | undefined;
  const parsedVerdict = parseVerdict(`${exec.stdout}\n${exec.stderr}`);
  if (parsedVerdict) domain = verdictToDomain(parsedVerdict);
  if (status === "passed" || status === "failed") {
    const from = target.epistemicStatus ?? "unverified";
    const to = status === "passed" ? verifier.onPass : verifier.onFail;
    if (from !== to) {
      if (domain && (to === "verified" || to === "falsified")) {
        boundCheck = checkBoundConsistency(target, domain);
        if (boundCheck && !boundCheck.ok) {
          // STRICT mismatch: refuse the transition — the claim states more than was proven.
          core.apply(proj, "claim.flagged", { kind: "verifier", id: verifier.id }, {
            objectId: target.id, reason: "bound mismatch", check: boundCheck,
          }, { correlationId: id, causationId: target.id });
          core.apply(proj, status === "passed" ? "verification.failed" : "verification.failed", { kind: "verifier", id: verifier.id }, {
            verificationId: id,
            output: `${outputText}\nBOUND MISMATCH — transition refused: ${boundCheck.detail}`,
            exitCode: exec.exitCode,
            artifactRef: artifact.id,
            appliedTransitions: [],
            verifiedDomain: domain,
          }, { correlationId: input.targetId });
          const refused = proj.verifications.get(id) as VerificationRecord;
          return { verification: refused, artifactRef: artifact.id, boundRefused: boundCheck.detail };
        }
        if (boundCheck && boundCheck.ok && boundCheck.flagged) {
          // heuristic overstatement on a legacy claim: transition stands, but flagged loudly
          core.apply(proj, "claim.flagged", { kind: "verifier", id: verifier.id }, {
            objectId: target.id, reason: "announced bound exceeds verified domain", check: boundCheck,
          }, { correlationId: id, causationId: target.id });
        }
      }
      core.apply(proj, "claim.status_changed", { kind: "verifier", id: verifier.id }, {
        objectId: target.id,
        from,
        to,
        via: id,
      }, { correlationId: id, causationId: target.id });
      transitions.push({ from, to });
    }
    // evidence object recording the deterministic result
    const evidenceId = core.nextId(proj, "evidence");
    core.apply(proj, "object.created", { kind: "verifier", id: verifier.id }, {
      object: {
        id: evidenceId,
        campaignId: proj.state.id,
        type: "evidence",
        title: `${verifier.id} ${status} on ${target.id}`,
        content: {
          kind: "deterministic-exec",
          verificationId: id,
          verifier: verifier.id,
          result: status === "passed" ? "supports" : "contradicts",
          exitCode: exec.exitCode,
          outputTail: outputText.slice(-2000),
        },
        epistemicStatus: "verified",
        verificationGrade: "deterministic-exec",
        tags: ["verifier-output", verifier.moduleId],
        branchId: target.branchId,
        createdBy: `verifier:${verifier.id}`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    }, { correlationId: id });
    const edgeId = core.nextId(proj, "edge");
    core.apply(proj, "edge.created", { kind: "verifier", id: verifier.id }, {
      edge: {
        id: edgeId,
        campaignId: proj.state.id,
        sourceId: evidenceId,
        targetId: target.id,
        relation: status === "passed" ? "supports" : "contradicts",
        properties: { via: id, deterministic: true },
        evidenceRef: evidenceId,
        createdBy: `verifier:${verifier.id}`,
        createdAt: nowIso(),
      },
    });
  }

  core.apply(proj, status === "passed" ? "verification.passed" : "verification.failed", { kind: "verifier", id: verifier.id }, {
    verificationId: id,
    output: outputText,
    exitCode: exec.exitCode,
    artifactRef: artifact.id,
    appliedTransitions: transitions,
    verifiedDomain: domain,
    boundFlag: boundCheck?.flagged === true && boundCheck.ok ? boundCheck.detail : undefined,
  }, { correlationId: input.targetId });

  const final = proj.verifications.get(id) as VerificationRecord;
  return { verification: final, artifactRef: artifact.id };
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function execCommand(cmd: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${String(err)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut });
    });
  });
}

/** Clean a verification sandbox dir (best effort). */
export function cleanSandbox(sandbox: string): void {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
