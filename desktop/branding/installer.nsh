; Uninstall cleanup.
;
; Removes everything the app keeps about the person who used it: the sign-in
; (credentials.json and the cookies exported for yt-dlp), the owned browser
; session, listening history, the resume point and settings — all of which live
; in one folder — plus the installer's own download cache.
;
; The folder is %APPDATA%\Spotifier, not one named after the product: main.js
; pins the data directory to its original name so renaming the app did not sign
; anyone out. electron-builder's deleteAppDataOnUninstall removes the folder
; named after the product, which here is the wrong one, so it is not used.
;
; Skipped when this uninstaller is running as part of an update. Installing a
; new version runs the old uninstaller silently first; clearing data there
; would sign the person out and wipe their history every time they updated.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    RMDir /r "$APPDATA\Spotifier"
    RMDir /r "$LOCALAPPDATA\youtube-music-spotified-updater"
  ${endIf}
!macroend
