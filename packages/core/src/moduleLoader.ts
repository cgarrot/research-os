// moduleLoader.ts — domain module discovery (spec §21). v0.1 modules are
// declarative: manifest + exec verifier definitions + skill folders. The core
// never imports module code (invariant F).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DomainModuleManifest, LoadedModule, VerifierDefinition } from "@research-os/contracts";

export function loadModules(modulePaths: string[]): LoadedModule[] {
  const modules: LoadedModule[] = [];
  for (const p of modulePaths) {
    const abs = path.resolve(p);
    if (!existsSync(abs)) continue;
    const entries = readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(abs, entry.name);
      const manifestFile = path.join(dir, "research.module.json");
      if (!existsSync(manifestFile)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as DomainModuleManifest;
        validateManifest(manifest, entry.name);
        const verifiers: VerifierDefinition[] = [];
        const verifierDir = path.join(dir, "verifiers");
        if (existsSync(verifierDir)) {
          for (const f of readdirSync(verifierDir)) {
            if (!f.endsWith(".json")) continue;
            const def = JSON.parse(readFileSync(path.join(verifierDir, f), "utf8")) as VerifierDefinition & { script?: string };
            if (def.kind !== "exec") continue;
            def.moduleDir = dir;
            def.moduleId = manifest.id;
            def.id = `${manifest.id}:${def.name ?? path.basename(f, ".json")}`;
            verifiers.push(def);
          }
        }
        const skillsDir = path.join(dir, "skills");
        const skills = existsSync(skillsDir)
          ? readdirSync(skillsDir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => ({ name: d.name, path: path.join(skillsDir, d.name) }))
          : [];
        const capabilitiesFile = path.join(dir, "capabilities.json");
        const capabilities = existsSync(capabilitiesFile)
          ? (JSON.parse(readFileSync(capabilitiesFile, "utf8")) as Record<string, unknown>)
          : undefined;
        modules.push({ manifest, dir, verifiers, skills, capabilities });
      } catch (err) {
        process.stderr.write(`[moduleLoader] skipping malformed module at ${dir}: ${String(err)}\n`);
      }
    }
  }
  return modules;
}

export function verifierById(modules: LoadedModule[], id: string): VerifierDefinition | undefined {
  return modules.flatMap((m) => m.verifiers).find((v) => v.id === id);
}

export function verifiersForCampaign(modules: LoadedModule[], campaignModules: string[]): VerifierDefinition[] {
  return modules.filter((m) => campaignModules.includes(m.manifest.id)).flatMap((m) => m.verifiers);
}

function validateManifest(m: DomainModuleManifest, dirName: string): void {
  if (!m.id || !m.name || !m.version) throw new Error("manifest needs id, name, version");
  if (m.id !== dirName) throw new Error(`manifest id "${m.id}" must match directory name "${dirName}"`);
  if (!Array.isArray(m.roles)) throw new Error("manifest roles must be an array");
  if (!m.safety || !m.safety.class) throw new Error("manifest needs safety.class");
}
