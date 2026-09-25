import type { Snapshot } from "./protocol.mjs";
export interface RoomStatus { status: "disconnected" | "connecting" | "reconnecting" | "connected"; role: "host" | "guest" | null; members: number; invitation: string; error: string | null }
export class RoomClient {
 constructor(options: { onStatus: (status: Partial<RoomStatus>) => void; onSnapshot: (snapshot: Snapshot) => void; getSnapshot: () => unknown });
 serverNow(): number;
 connect(options: { server?: string; invitation?: string }): void;
 publish(): void;
 stop(error?: string | null): void;
}
