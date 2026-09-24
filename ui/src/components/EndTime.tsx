import { useSettings } from "../lib/settings";
import { formatDuration } from "../lib/types";

export function EndTime({ duration, position, className }: { duration: number; position: number; className: string }) {
  const remaining = useSettings(s => s.remainingTime);
  return <button className={`${className} end-time`} aria-label={remaining ? "Show total duration" : "Show remaining time"}
    title={remaining ? "Show total duration" : "Show remaining time"}
    onClick={() => useSettings.getState().set("remainingTime", !remaining)}>
    {remaining ? `−${formatDuration(Math.max(0, duration - position))}` : formatDuration(duration)}
  </button>;
}
