# Sign-in replacement investigation

The current desktop flow imports a session from a separate browser profile. The local core authenticates InnerTube requests with Google/YouTube cookies and SAPISID request signatures; this is not a Google OAuth client.

## Decision

Do not replace the working flow with an embedded Google login window. Google's [native-app documentation](https://developers.google.com/identity/protocols/oauth2/native-app) describes `disallowed_useragent`, and its [OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies) prohibits embedded authorization agents. Existing experiments in `desktop/auth.js` also recorded rejection of fresh sessions. Removing Electron identifiers is not a reliable solution.

A supported native OAuth flow would still use a system browser and requires a maintainer-owned client registration. It returns access tokens, not the cookie session this backend expects. It therefore needs an API/authentication feasibility prototype before it could replace sign-in. Device-code login is not a desktop shortcut for these restrictions.

## Proposed follow-up

1. Inventory every authenticated catalogue, channel-switching, mutation and playback operation and establish which supported API/token scopes can satisfy it.
2. Once that is proven, register a desktop OAuth client under upstream ownership, use authorization code with PKCE and an ephemeral loopback callback, and store refresh credentials with OS-protected storage.
3. Keep progress, cancellation, errors and account selection in the app. Authentication itself opens in the supported system browser. Test Google rejection, cancellation, callback state validation, multiple accounts/channels and token revocation on both operating systems.
4. Remove the Chrome-cookie flow only after feature parity and account testing. Until then #19 remains relevant; #20 does not supersede it yet.

This investigation does not claim that an in-app-only Google authentication flow has been delivered. No client registration, new scopes or account permissions were created. The existing sign-in implementation remains unchanged.
