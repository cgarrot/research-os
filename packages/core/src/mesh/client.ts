// mesh/client.ts — minimal mesh.v1 client speaking NDJSON to the local pi-mesh
// broker (same broker as all Pi workers on this machine). Research content
// never lives here — mesh is transport only (spec §7, invariant B).
import { connect, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MeshFrame {
  v: number;
  type: string;
  id: string;
  from?: string;
  to?: string;
  room?: string;
  body?: string;
  refs?: string[];
  status?: string;
  code?: string;
  broadcast?: boolean;
  rooms?: string[];
  peers?: unknown;
  deliveredCount?: number;
  totalCount?: number;
  ts: string;
  [k: string]: unknown;
}

export interface MeshSendReceipt {
  ok: boolean;
  status: string;
  msgId?: string;
  detail?: string;
}

function socketPath(): string {
  if (process.env.MESH_RUNTIME_DIR) return path.join(process.env.MESH_RUNTIME_DIR, "broker.sock");
  let uid = "0";
  try {
    uid = String(os.userInfo().uid);
  } catch {
    /* keep 0 */
  }
  return path.join(os.tmpdir(), `mesh-${uid}`, "broker.sock");
}

export class MeshClient {
  private sock: Socket | null = null;
  private connected = false;
  private buffer = "";
  private pendingAcks = new Map<string, (r: MeshSendReceipt) => void>();
  private pendingStatus: ((f: MeshFrame) => void) | null = null;
  private alias: string;
  private rooms: string[] = [];
  readonly onMessage: (frame: MeshFrame) => void;

  constructor(opts: { alias: string; rooms?: string[]; onMessage?: (frame: MeshFrame) => void }) {
    this.alias = opts.alias;
    this.rooms = opts.rooms ?? [];
    this.onMessage = opts.onMessage ?? (() => {});
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get socketFilePath(): string {
    return socketPath();
  }

  /** broker lockfile pid if present (used to auto-spawn check) */
  brokerPid(): number | null {
    const lock = path.join(path.dirname(socketPath()), "broker.lock");
    if (!existsSync(lock)) return null;
    try {
      return Number(readFileSync(lock, "utf8").trim());
    } catch {
      return null;
    }
  }

  async connect(): Promise<boolean> {
    const sp = socketPath();
    if (!existsSync(sp)) return false;
    return new Promise((resolve) => {
      const sock = connect(sp);
      const fail = (why: string) => {
        sock.destroy();
        this.connected = false;
        resolve(false);
        void why;
      };
      sock.once("error", () => fail("error"));
      sock.once("connect", () => {
        const hello: MeshFrame = {
          v: 1,
          type: "hello",
          id: `m_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
          from: this.alias,
          rooms: this.rooms.length > 0 ? this.rooms : ["default"],
          clientVersion: "researchd/0.1",
          ts: new Date().toISOString(),
        };
        sock.write(JSON.stringify(hello) + "\n");
      });
      sock.on("data", (chunk) => {
        this.buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let frame: MeshFrame;
          try {
            frame = JSON.parse(line) as MeshFrame;
          } catch {
            continue;
          }
          this.handleFrame(frame);
          if (frame.type === "welcome") {
            this.connected = true;
            this.sock = sock;
            resolve(true);
          }
        }
      });
      sock.once("close", () => {
        this.connected = false;
        this.sock = null;
      });
      setTimeout(() => {
        if (!this.connected) fail("hello timeout");
      }, 4000).unref?.();
    });
  }

  private handleFrame(frame: MeshFrame): void {
    switch (frame.type) {
      case "ack":
        this.pendingAcks.get(frame.id)?.({ ok: frame.status === "ok" || frame.status === "delivered" || frame.status === "queued_offline", status: frame.status ?? "ok", msgId: frame.id, detail: frame.status });
        this.pendingAcks.delete(frame.id);
        break;
      case "error":
        this.pendingAcks.get(frame.id)?.({ ok: false, status: `error:${frame.code ?? "unknown"}`, msgId: frame.id, detail: frame.code });
        this.pendingAcks.delete(frame.id);
        break;
      case "msg":
      case "reply":
      case "remind":
        this.onMessage(frame);
        break;
      case "status_res":
        this.pendingStatus?.(frame);
        break;
      default:
        break;
    }
  }

  private send(frame: MeshFrame): Promise<MeshSendReceipt> {
    if (!this.sock || !this.connected) {
      return Promise.resolve({ ok: false, status: "disconnected" });
    }
    return new Promise((resolve) => {
      this.pendingAcks.set(frame.id, resolve);
      this.sock?.write(JSON.stringify(frame) + "\n");
      setTimeout(() => {
        if (this.pendingAcks.has(frame.id)) {
          this.pendingAcks.delete(frame.id);
          resolve({ ok: false, status: "timeout" });
        }
      }, 5000).unref?.();
    });
  }

  sendTo(to: string, body: string, opts?: { refs?: string[] }): Promise<MeshSendReceipt> {
    return this.send({
      v: 1,
      type: "msg",
      id: nextMsgId(),
      from: this.alias,
      to,
      body,
      refs: opts?.refs,
      ts: new Date().toISOString(),
    });
  }

  broadcast(room: string, body: string, opts?: { refs?: string[] }): Promise<MeshSendReceipt> {
    return this.send({
      v: 1,
      type: "msg",
      id: nextMsgId(),
      from: this.alias,
      to: `${room}-broadcast`,
      room,
      broadcast: true,
      body,
      refs: opts?.refs,
      ts: new Date().toISOString(),
    });
  }

  async status(): Promise<unknown> {
    if (!this.connected) return { connected: false };
    return new Promise((resolve) => {
      this.pendingStatus = (f) => {
        this.pendingStatus = null;
        resolve({ connected: true, peers: f.peers, stats: f.stats });
      };
      this.sock?.write(JSON.stringify({ v: 1, type: "status_req", id: nextMsgId(), from: this.alias, ts: new Date().toISOString() }) + "\n");
      setTimeout(() => {
        if (this.pendingStatus) {
          this.pendingStatus = null;
          resolve({ connected: true, peers: null, note: "status timeout" });
        }
      }, 4000).unref?.();
    });
  }

  ping(): void {
    if (this.connected && this.sock) {
      this.sock.write(JSON.stringify({ v: 1, type: "ping", id: nextMsgId(), from: this.alias, ts: new Date().toISOString() }) + "\n");
    }
  }

  joinRoom(room: string): void {
    if (!this.rooms.includes(room)) this.rooms.push(room);
    if (this.connected && this.sock) {
      this.sock.write(JSON.stringify({ v: 1, type: "join", id: nextMsgId(), from: this.alias, room, ts: new Date().toISOString() }) + "\n");
    }
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
    this.connected = false;
  }
}

function nextMsgId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}
