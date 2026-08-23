// eventStore.ts — append-only JSONL event log per campaign (spec §5).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { ResearchEvent } from "@research-os/contracts";
import { ensureDir } from "./util.js";

export class EventStore {
  constructor(private readonly file: string) {}

  static open(campaignStateDir: string): EventStore {
    ensureDir(campaignStateDir);
    return new EventStore(path_join(campaignStateDir, "events.jsonl"));
  }

  append(event: ResearchEvent): void {
    appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8");
  }

  readAll(): ResearchEvent[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n");
    const events: ResearchEvent[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t) as ResearchEvent);
      } catch {
        // torn write at tail — tolerated, event is re-emitted with new id
      }
    }
    return events;
  }
}

// tiny local path join to avoid importing node:path twice styles
function path_join(dir: string, file: string): string {
  return dir.endsWith("/") ? dir + file : dir + "/" + file;
}
