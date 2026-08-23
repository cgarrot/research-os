# modules/ — the domain-module norm

A domain module teaches ResearchOS how research works in a field **without any core changes** (invariant F). Modules are DECLARATIVE: the core loads manifests and runs exec verifiers itself; it never imports module code. Zero-code modules = sandbox-friendly and language-agnostic.

## Anatomy

```
modules/<id>/
  research.module.json     # manifest (id MUST equal the directory name)
  verifiers/<name>.json    # exec verifier definitions
  verifiers/<script>       # deterministic script(s) the definitions call
  skills/<skill>/SKILL.md  # seed skills (copied into campaign workspaces)
```

## Manifest fields (`research.module.json`)

- `roles[]` — scheduling/context templates (`name`, `description`)
- `diversityDescriptors[]` — seeds for genuinely different blind branches (generate phase picks round-robin)
- `prompts` — phase guidance. Keys `worker`, `ground`, `generate`, `critique`, `test`, `consolidate`. Injected (replay-safely) into task goals + ContextPack `moduleGuidance`. Write them as OPERATIONAL rules, not vibes.
- `verifiers[]` — json file list; `skills[]` — skill dir list (loader also auto-discovers `skills/*/SKILL.md`)
- `runtimeRequirements.executables` / `optionalExecutables` — document what the verifiers need
- `safety.class` — low/medium/high; a module can never silently enable high-risk actions

## Verifier definition (json)

```json
{
  "name": "exhaustive-finite",            // id becomes "<moduleId>:exhaustive-finite"
  "kind": "exec",
  "label": "…", "description": "…",       // description is shown to workers — make it teach WHEN to use it
  "command": ["python3", "{script}", "{input_file}"],
  "script": "verifiers/check.py",         // resolved relative to the module dir
  "timeoutSeconds": 600,
  "onPass": "verified",                   // epistemic status on exit ∈ passExitCodes
  "onFail": "falsified",                  // … on other exits. "inconclusive" = no transition
  "passExitCodes": [0],                   // optional, default [0]; timeout → status error
  "inputs": [{ "name": "…", "description": "…", "required": true }]
}
```

Placeholders in `command`: `{script} {input_file} {workspace} {campaign_dir}`. Input JSON is written to `{input_file}`; the verifier runs in its own sandbox dir under the campaign state, with a timeout, and its full output becomes an immutable artifact. `onPass`/`onFail` are the ONLY worker-unreachable status transitions in the system (invariant C).

Script contract: deterministic, no network, print a JSON verdict line, exit 0/1 meaningfully, 2 on input error. **The script must recompute everything itself — never trust values supplied by the worker** (witnesses yes, conclusions no).

## Skills

`skills/<name>/SKILL.md` with frontmatter `name` + `description` (when to use). Skills are copied into campaign workspaces at creation and read by workers on demand. Keep them short, procedural, with concrete tool calls.

## Loader rules (`packages/core/src/moduleLoader.ts`)

- Discovered from `RESEARCH_MODULES` dir (default `<repo>/modules`), at daemon start — restart researchd after adding/editing a module.
- `manifest.id` must match the directory name; verifier ids are namespaced `<moduleId>:<name-or-filename>`.
- A verifier is only runnable by campaigns whose `modules:` list includes the module (isolation enforced server-side).

## Adding a new module — checklist

1. `modules/<id>/research.module.json` (+ verifiers + skills).
2. Restart researchd; check `research doctor` + `GET /v1/verifiers`.
3. Engine test in `apps/researchd/src/test/` covering each verifier's pass/fail transition.
4. Optional: a campaign YAML in `examples/`, a section in the module's `AGENTS.md`.
