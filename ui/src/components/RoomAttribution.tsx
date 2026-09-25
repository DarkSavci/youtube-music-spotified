import { useTogether } from "../lib/together";
import { Artwork } from "./Artwork";
/** Entry identity, not song ID, distinguishes repeated songs in the room. */
export function RoomAttribution({ index }: { index?: number }) {
  const room = useTogether((s) => s.room);
  const entry =
    index === undefined
      ? room?.queue.find((e) => e.id === room.current)
      : room?.queue[index];
  if (!entry) return null;
  return (
    <span
      className="room-attribution"
      title={`Added by ${entry.addedBy.name}`}
      aria-label={`Added by ${entry.addedBy.name}`}
    >
      {entry.addedBy.avatar ? (
        <Artwork src={entry.addedBy.avatar} alt="" />
      ) : (
        <span>{entry.addedBy.name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
