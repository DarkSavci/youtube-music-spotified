import { Artwork } from "./Artwork";

export const initial = (name: string) => name.trim().slice(0, 1).toUpperCase();

/** A listener's picture, or their initial when they share none. */
export function RoomAvatar({
  member,
  small = false,
}: {
  member: { name: string; avatar?: string };
  small?: boolean;
}) {
  return (
    <span
      className={`room-avatar ${small ? "room-avatar--small" : ""}`}
      title={member.name}
      aria-label={member.name}
    >
      <Artwork src={member.avatar} alt="" fallback={initial(member.name)} />
    </span>
  );
}
