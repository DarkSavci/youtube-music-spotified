# Music video playback

Use Song / Video beside the volume control to switch formats. YouTube Music must explicitly identify a corresponding version; the app does not guess from search results. Existing video tracks can also be watched directly. Switching versions preserves the queue, elapsed position, pause state, shuffle and repeat. Different edits may have different timing, so the same elapsed position is not always the same musical moment.

The main view, expanded now-playing view and artwork layouts of the mini-player share one muted picture element. The existing audio engine remains the only sound source and playback clock. Closing the video view leaves audio playback available. The compact bar mini-player retains its small artwork thumbnail.

Video uses yt-dlp to select an HTTP MP4 or WebM stream up to 1080p. A separate bounded resolution cache and byte-range relay keep video out of the offline audio cache. Picture buffering catches up to the audio timeline. Account restrictions or unavailable versions produce an error with a retry option; audio remains available.

Listen Together guests can watch the currently selected video, but changing to another song/video ID remains a host action.

## Validation

- Go tests cover explicit counterpart parsing, video format selection, relay ranges/cache separation, and atomic session switching.
- Desktop tests cover format selection and one muted picture following the audio timeline.
- `electron desktop/test/video-smoke.js` checks actual video decoding, seeking and transfer between documents. Optional `VIDEO_SMOKE_ORIGIN` and `VIDEO_SMOKE_ID` exercise a running local core with a real video.
- On macOS arm64, real 1080p MP4 decoding, main/expanded/mini-player views, play/pause, and end-to-end Song/Video switching at the preserved paused position were verified.

The mini-player selects one view at a time: video, queue, or lyrics. Switching its view does not change the playback version or hide video in the main window. The main window continues to support video alongside lyrics.

If a video has no lyrics, the app tries its explicitly linked song version. Synced lyrics are retained when both durations are known and differ by at most three seconds; otherwise the fallback is plain text.
