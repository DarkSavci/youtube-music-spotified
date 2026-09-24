export interface RoomTrack { id: string; title: string; durationMs: number; artists: { name: string }[] }
export interface Snapshot { track: RoomTrack | null; playing: boolean; positionMs: number; at: number; seq: number }
export function cleanSnapshot(value: unknown): Omit<Snapshot, "at" | "seq">;
export function positionAt(snapshot: Snapshot, serverNow: number): number;
export function endpointURL(input: string): string;
export function encodeInvite(server: string, room: string, token: string): string;
export function decodeInvite(input: string): { server: string; room: string; token: string };
