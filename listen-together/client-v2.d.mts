export interface RoomTrack {
  id: string;
  title: string;
  artists: { name: string }[];
  durationMs: number;
  isVideo: boolean;
  explicit: boolean;
  playable: boolean;
  artwork: { url: string; width: number; height: number }[];
}
export interface Member {
  id: string;
  name: string;
  avatar: string;
  connected: boolean;
  ready?: boolean;
  status: string;
  role: "dj" | "listener";
}
export interface Entry {
  id: string;
  track: RoomTrack;
  addedBy: Pick<Member, "id" | "name" | "avatar">;
  addedAt: number;
}
export type RoomMode = "collaborative" | "contributions" | "listen";
export interface RoomState {
  name: string;
  id: string;
  pin: string;
  members: Member[];
  owner: string;
  mode: RoomMode;
  locked: boolean;
  joinApproval: boolean;
  pending: { id: string; name: string; avatar: string }[];
  countdown: { expires: number; startAt: number | null } | null;
  queue: Entry[];
  current: string | null;
  positionMs: number;
  at: number;
  playing: boolean;
  revision: number;
  expires: number;
  activity: { id: string; text: string; at: number }[];
  history: Entry[];
  repeat: "off" | "all" | "one";
  policy: "fifo" | "turns";
  duplicates: boolean;
  limit: number;
  lastControlledBy: { id: string; name: string } | null;
  video: { shown: boolean; by: string; revision: number } | null;
  votes: string[];
  voteSkip: boolean;
  undo: { revision: number; expires: number; by: string } | null;
}
export interface ConnectOptions {
  server: string;
  pin?: string;
  roomName?: string;
  mode?: RoomMode;
  profile: { name: string; avatar?: string };
}
export class RoomClientV2 {
  constructor(options: {
    onState: (room: RoomState) => void;
    onStatus: (
      status: "connecting" | "reconnecting" | "connected" | "waiting",
    ) => void;
    onError: (message: string) => void;
    onEnded: (message: string) => void;
    onJoined?: (member: string) => void;
  });
  member: string;
  serverNow(): number;
  connect(options: ConnectOptions): void;
  command(data: Record<string, unknown>): Promise<boolean>;
  send(data: Record<string, unknown>): void;
  leave(next?: string): void;
  stop(): void;
}
export function checkRoomServer(input: string): Promise<boolean>;
