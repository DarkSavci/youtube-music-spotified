# macOS release archives

The release workflow prepares one version commit, builds Windows x64 and macOS arm64/x64 from that exact commit, tests bundled helpers, then publishes all assets together. A build failure prevents publishing and pushing the version commit. If master advances during the builds, its non-fast-forward push is rejected.

Mac assets are ZIP archives containing `Youtube Music Spotified.app`. Choose arm64 for Apple Silicon or x64 for Intel; extract and move the app to Applications. These builds use ad-hoc signatures to verify the packaged bundle, not an Apple Developer ID. They are not notarized. The publisher must clearly label this limitation; signed distribution requires upstream signing credentials in a later change.

SHA256SUMS.txt covers the installer and Mac archives. Windows retains its installer/blockmap/latest.yml auto-update assets. Mac automatic updates remain disabled; install later archives manually. No release is dispatched by a PR or by these code changes.
