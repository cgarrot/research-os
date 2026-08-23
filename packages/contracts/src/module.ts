// module.ts — domain module manifest and what a module contributes (spec §21).
// v0.1 modules are declarative directories: manifest + skills + exec verifiers.
// The core never imports module code; it loads manifests and runs declared
// exec verifiers itself, so modules stay sandbox-friendly.

export interface DomainModuleManifest {
  id: string; // e.g. "mathematics-lite"
  name: string;
  version: string;
  coreApi: string; // ">=0.1 <0.2"
  capabilities: string[];
  roles: { name: string; description: string }[];
  diversityDescriptors: string[];
  skills: string[]; // relative skill dir names shipped by the module
  verifiers: string[]; // verifier definition json files
  safety: { class: "low" | "medium" | "high"; notes?: string };
  prompts?: Record<string, string>;
}

export interface LoadedModule {
  manifest: DomainModuleManifest;
  dir: string;
  verifiers: import("./verification.js").VerifierDefinition[];
  skills: { name: string; path: string }[];
  /** machine-readable verifier/expression capabilities (V0.5.4) */
  capabilities?: Record<string, unknown>;
}

export interface WorkspaceConfig {
  core: { storage: "file"; artifacts: "local" };
  runtime: { default: "pi" };
  transport: { default: "pi-mesh" };
  modules: { paths: string[] };
  researchd: { baseUrl: string };
}
