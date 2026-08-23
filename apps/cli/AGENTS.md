# apps/cli — the `research` CLI

Single file: `src/main.ts`. Talks to researchd over `RESEARCH_URL` (default `http://127.0.0.1:8787`). YAML parsing via the only dependency (`yaml`).

## Commands

```
research doctor
research campaign create <file.yaml>     # yaml must have a top-level `campaign:` key
research campaign list | status <id> | start|pause|resume|stop <id>
research campaign report <id>            # markdown from durable state
research campaign events <id> [limit]    # tail of the event log
research branch|task|worker <campaignId>
research object <ref>                    # e.g. hypothesis:h_3
research graph <campaignId> <ref>        # expand around ref
research verify <campaignId> <objRef> <verifierId> '<inputJson>'
```

Campaign ids accepted both as `c_1` and `campaign:c_1` (`normalizeId` strips the prefix for path segments).

## Conventions

- Errors: `{error}` from the daemon is surfaced as `error: <msg>`, exit 1.
- The `test` script must keep the glob form `node --test dist/test/*.test.js` (trailing-slash dirs break `node --test`).
- New commands: add a `case` in `main()` and keep help text in the default case in sync.
