import { create } from "zustand";
import { useSettings } from "./settings";
import { usePlayer, currentPosition } from "./player";
import { useTogether } from "./together";
import { artistNames, artworkAtLeast } from "./types";

export const useDiscord = create(() => ({ status: "disabled" }));
export function installDiscordPresence() {
  const bridge = window.spotifier?.discordPresence;
  if (!bridge) return () => {};
  let disposed = false,
    sequence = 0;
  const send = () => {
    const prefs = useSettings.getState(),
      player = usePlayer.getState(),
      track = player.track;
    const request = ++sequence;
    const room = useTogether.getState().room;
    const value = !prefs.discordEnabled
      ? { enabled: false }
      : {
          enabled: true,
          clientId: prefs.discordApplicationId,
          playing: player.state === "playing" && !player.outputElsewhere,
          id: track?.id,
          title: track?.title,
          artist: track ? artistNames(track.artists) : "",
          album: track?.album?.name,
          artwork: artworkAtLeast(track?.artwork ?? [], 300),
          durationMs: track?.durationMs,
          positionMs: currentPosition(player),
          speed: player.speed,
          shareRoom: prefs.discordShareRoom,
          roomName: room?.name,
        };
    void bridge(value)
      .then((status) => {
        if (!disposed && request === sequence) useDiscord.setState({ status });
      })
      .catch(() => {
        if (!disposed) useDiscord.setState({ status: "unavailable" });
      });
  };
  const settings = useSettings.subscribe(send);
  const player = usePlayer.subscribe((next, previous) => {
    if (
      next.track !== previous.track ||
      next.state !== previous.state ||
      next.speed !== previous.speed ||
      next.outputElsewhere !== previous.outputElsewhere ||
      Math.abs(currentPosition(next) - currentPosition(previous)) > 1500
    )
      send();
  });
  const room = useTogether.subscribe((next, previous) => {
    if (next.room?.name !== previous.room?.name) send();
  });
  const status =
    window.spotifier?.onDiscordStatus?.((next) => {
      if (!disposed) useDiscord.setState({ status: next });
    }) ?? (() => {});
  const timer = setInterval(send, 15000);
  send();
  return () => {
    disposed = true;
    settings();
    player();
    room();
    status();
    clearInterval(timer);
    void bridge({ enabled: false }).catch(() => {});
  };
}
