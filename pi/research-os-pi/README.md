# research-os-pi

Pi extension + skill turning a Pi session into a ResearchOS worker.

- `extension/index.ts` — registers the `research_*` tools (read / write /
  read / write / coordination tools) talking to the `researchd` HTTP API.
- `skills/research-worker/SKILL.md` — the worker loop + hard rules.

## Usage

Campaign workspaces get a copy automatically (`.pi/` scaffolded by researchd).
To install globally instead:

```bash
pi install ./pi/research-os-pi
```

Environment:

- `RESEARCH_URL` — researchd base URL (default `http://127.0.0.1:8787`)
- `RESEARCH_WORKER_ALIAS` — worker identity used for leases
- `RESEARCH_CAMPAIGN` — campaign id (else first campaign is used by tools that need one)
