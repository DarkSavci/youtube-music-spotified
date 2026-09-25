import { retryTogetherPlayback } from "../lib/together";
import { usePlayer } from "../lib/player";

/**
 * Why playback is not proceeding.
 *
 * Only shown for states the user can wait out or act on. A rate limit is the
 * one that needs saying: without it, playback simply stops and the obvious
 * reading is that the app is broken — so the next thing anyone does is retry
 * repeatedly, which is exactly what prolongs it.
 *
 * A track that merely failed is not announced here; its row is greyed instead.
 */
export function PlaybackNotice() {
  const following = usePlayer(s => s.followingRoom);
  const notice = usePlayer((s) => s.notice);
  if (!notice) return null;

  return (
    <div className="playnotice" role="status">
      {notice}
      {following ? <button className="chip" onClick={retryTogetherPlayback}>Retry playback</button> : null}
    </div>
  );
}
