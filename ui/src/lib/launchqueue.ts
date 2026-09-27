import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { idleForRemoteQueue, loadQueuePaused } from "./playback";
import { usePlayer } from "./player";
import { continueOnLaunch } from "./remotequeue";
import { useSettings } from "./settings";
import { toast } from "./toast";

/*
 * Launch is once per run of the app, not once per window load: a reload of
 * the window keeps this, a new run starts without it.
 */
const DONE = "spotifier.continuedOnLaunch";

function alreadyDone(): boolean {
  try {
    return sessionStorage.getItem(DONE) === "1";
  } catch {
    return false;
  }
}

function markDone() {
  try {
    sessionStorage.setItem(DONE, "1");
  } catch {
    /* storage blocked: at worst a reload asks again */
  }
}

/**
 * Picks up the account's queue from another device when the app starts, if
 * the "Continue from YouTube Music" setting is on.
 *
 * Decided once, as soon as the account's state is known: turning the setting
 * on later does not reach back to a launch that has passed, and a signed-out
 * launch never asks.
 */
export function useContinueOnLaunch() {
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: ({ signal }) => api.me(signal),
    staleTime: 60_000,
  });
  const known = me !== undefined;
  const signedIn = me?.state === "signed_in";

  useEffect(() => {
    if (!known || alreadyDone()) return;
    markDone();
    if (!signedIn || !useSettings.getState().continueFromYouTubeMusic) return;
    void continueOnLaunch({
      fetchQueue: () => api.remoteQueue(),
      idle: idleForRemoteQueue,
      currentId: () => {
        const s = usePlayer.getState();
        return s.queue[s.index]?.id;
      },
      load: loadQueuePaused,
      toast: (message) => toast(message),
    }).then((result) => console.debug("[remote queue] at launch:", result));
  }, [known, signedIn]);
}
