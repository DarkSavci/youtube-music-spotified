import { useSettings } from "../lib/settings";
import { formatDuration } from "../lib/types";

export function EndTime({ duration, position, className }: { duration: number; position: number; className: string }) {
  const remaining = useSettings(s => s.remainingTime);
  return <button className={`${className} end-time`} aria-label={remaining ? "Show total duration" : "Show remaining time"}
    title={remaining ? "Show total duration" : "Show remaining time"}
    onClick={() => useSettings.getState().set("remainingTime", !remaining)}>
    {remaining && duration > 0 ? `−${duration <= position ? "0:00" : formatDuration(duration - position)}` : formatDuration(duration)}
  </button>;
}
