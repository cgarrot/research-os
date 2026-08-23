// artifacts.ts — content-addressed immutable artifact store (spec §20).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactManifest } from "@research-os/contracts";
import type { CampaignProjection, ResearchCore } from "./core.js";
import { nowIso } from "./util.js";

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

function storeRoot(proj: CampaignProjection): string {
  return path.join(proj.stateDir, "artifacts");
}

/** Register a workspace file (or inline base64 content) as an immutable artifact. */
export function registerArtifact(
  core: ResearchCore,
  proj: CampaignProjection,
  input: { workspacePath?: string; contentBase64?: string; logicalName: string; mediaType?: string; producer: string; branchId?: string; experimentId?: string; parents?: string[] },
): ArtifactManifest {
  let buf: Buffer;
  if (input.contentBase64 !== undefined) {
    buf = Buffer.from(input.contentBase64, "base64");
  } else if (input.workspacePath) {
    const abs = path.resolve(proj.workspaceDir, input.workspacePath);
    if (!abs.startsWith(path.resolve(proj.workspaceDir))) throw new Error(`artifact path escapes workspace: ${input.workspacePath}`);
    if (!existsSync(abs)) throw new Error(`artifact file not found: ${abs}`);
    const st = statSync(abs);
    if (st.size > MAX_ARTIFACT_BYTES) throw new Error(`artifact too large (${st.size} bytes)`);
    buf = readFileSync(abs);
  } else {
    throw new Error("artifact needs workspacePath or contentBase64");
  }
  return registerArtifactBytes(core, proj, buf, input);
}

export function registerArtifactBytes(
  core: ResearchCore,
  proj: CampaignProjection,
  buf: Buffer,
  input: { logicalName: string; mediaType?: string; producer: string; branchId?: string; experimentId?: string; parents?: string[] },
): ArtifactManifest {
  const sha = createHash("sha256").update(buf).digest("hex");
  // content dedupe: same bytes already registered → return existing manifest
  for (const a of proj.artifacts.values()) {
    if (a.sha256 === sha) return a;
  }
  const dir = path.join(storeRoot(proj), sha.slice(0, 2));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, sha);
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);
  }
  const id = core.nextId(proj, "artifact");
  const manifest: ArtifactManifest = {
    id,
    sha256: sha,
    mediaType: input.mediaType ?? guessMediaType(input.logicalName),
    size: buf.byteLength,
    logicalName: input.logicalName,
    producer: input.producer,
    campaignId: proj.state.id,
    branchId: input.branchId,
    experimentId: input.experimentId,
    parents: input.parents ?? [],
    createdAt: nowIso(),
    storagePath: path.relative(storeRoot(proj), dest),
  };
  core.apply(proj, "artifact.created", { kind: input.producer.startsWith("verifier") ? "verifier" : "worker", id: input.producer }, { manifest });
  return manifest;
}

export function artifactContentPath(proj: CampaignProjection, id: string): string | null {
  const m = proj.artifacts.get(id);
  if (!m) return null;
  return path.join(storeRoot(proj), m.storagePath);
}

export function readArtifact(proj: CampaignProjection, id: string): Buffer | null {
  const p = artifactContentPath(proj, id);
  if (!p || !existsSync(p)) return null;
  return readFileSync(p);
}

function guessMediaType(name: string): string {
  if (name.endsWith(".py")) return "text/x-python";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".lean")) return "text/x-lean";
  return "application/octet-stream";
}
