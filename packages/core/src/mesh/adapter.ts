// mesh/adapter.ts — PiMeshTransportAdapter: core-facing transport contract
// (spec §7.2) backed by the minimal mesh.v1 client. Reconnects lazily; the
// broker is owned by the pi-mesh extension world, not by researchd.
import type { AgentTransportAdapter, TransportIdentity, TransportReceipt } from "@research-os/contracts";
import { MeshClient, type MeshFrame } from "./client.js";

export class PiMeshTransportAdapter implements AgentTransportAdapter {
  readonly id = "pi-mesh";
  private client: MeshClient | null = null;
  private identity: TransportIdentity | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly onInbound?: (frame: MeshFrame) => void) {}

  async connect(identity: TransportIdentity): Promise<void> {
    this.identity = identity;
    await this.ensureConnected();
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = setInterval(() => {
      void this.ensureConnected();
      this.client?.ping();
    }, 20_000);
    this.reconnectTimer.unref?.();
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.client?.isConnected) return true;
    this.client?.close();
    if (!this.identity) return false;
    this.client = new MeshClient({
      alias: this.identity.alias,
      rooms: this.identity.rooms,
      onMessage: (f) => this.onInbound?.(f),
    });
    return this.client.connect();
  }

  async send(to: string, message: string, opts?: { room?: string; refs?: string[] }): Promise<TransportReceipt> {
    const ok = await this.ensureConnected();
    if (!ok || !this.client) return { ok: false, status: "offline" };
    const r = await this.client.sendTo(to, message, opts);
    return { ok: r.ok, status: r.status, msgId: r.msgId, detail: r.detail };
  }

  async broadcast(room: string, message: string, refs?: string[]): Promise<TransportReceipt> {
    const ok = await this.ensureConnected();
    if (!ok || !this.client) return { ok: false, status: "offline" };
    const r = await this.client.broadcast(room, message, { refs });
    return { ok: r.ok, status: r.status, msgId: r.msgId, detail: r.detail };
  }

  async status(): Promise<unknown> {
    if (!this.client?.isConnected) return { connected: false, brokerSocket: this.client?.socketFilePath };
    return this.client.status();
  }

  joinRoom(room: string): void {
    this.client?.joinRoom(room);
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.client?.close();
  }
}
