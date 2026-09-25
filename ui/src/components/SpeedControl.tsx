import { useMenu, type MenuItem } from "./ContextMenu";
import { IconCheckCircle } from "./Icon";
import { usePlayer } from "../lib/player";
import { useSettings } from "../lib/settings";
import { useTogether } from "../lib/together";
import { availableSpeeds } from "../lib/playback";
import { SPEEDS, formatSpeed } from "../lib/speed";
import { toast } from "../lib/toast";

/**
 * The playback speed button: the speed in effect, and a menu of the rest.
 *
 * Shown as its number rather than an icon, because the number is the state —
 * and it takes the accent colour whenever it is not 1×, so a sped-up player
 * is never mistaken for a normal one. Speeds the engine cannot play are listed
 * but disabled. In Listen Together the room holds everyone at 1×, and the
 * button says so rather than offering a choice that would not take.
 *
 * `titled` gives it a native tooltip, for the mini player, which has no
 * tooltip layer of its own.
 */
export function SpeedControl({ titled = false }: { titled?: boolean }) {
  const menu = useMenu();
  const speed = usePlayer((s) => s.speed);
  const chosen = useSettings((s) => s.playbackSpeed);
  const setSetting = useSettings((s) => s.set);
  const inRoom = useTogether((s) => s.role !== null);
  const label = inRoom
    ? "Playback speed: 1× in Listen Together"
    : `Playback speed: ${formatSpeed(speed)}`;

  return (
    <button
      className="iconbtn speedbtn"
      aria-label={label}
      title={titled ? label : undefined}
      aria-disabled={inRoom || undefined}
      data-active={speed !== 1 || undefined}
      onClick={(e) => {
        if (inRoom) {
          toast("Listen Together keeps everyone at normal speed.");
          return;
        }
        const offered = availableSpeeds();
        const items: MenuItem[] = SPEEDS.map((rate) => ({
          label: rate === 1 ? "1× (normal)" : formatSpeed(rate),
          icon: rate === chosen ? <IconCheckCircle size={18} /> : <span className="speedbtn__blank" />,
          disabled: !offered.includes(rate),
          onSelect: () => setSetting("playbackSpeed", rate),
        }));
        menu.open(e, items);
      }}
    >
      {formatSpeed(speed)}
    </button>
  );
}
