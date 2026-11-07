<p align="center">
  <img src="/assets/smokesync.png" alt="logo" height="300">
</p>

---

SmokeSync uses a Google Apps Script to build a playlist that automatically updates based on filters. Fully automatic and in the background.
# [Builder](https://script.google.com/macros/s/AKfycbxAQr-3Di5yy6M_bwJFaZs9eHPgM9M7fMruneZa7v9ZeBkpO359BIEC9h7vBzgmrWWf/exec)

The template validates every replacement search page before changing a playlist.
Empty or malformed results leave the existing playlist untouched. New maps are
added before obsolete maps are removed; an addition failure preserves every
original member. Existing desired maps stay in place, so reconciliation preserves
membership without promising a fresh ordering of all maps.

Before mutations, the script saves original and desired map IDs under
`smokeSyncPending:<playlist ID>` in Script Properties. Failures retain that recovery
snapshot, including across retries. A successful reconciliation clears it. If
Properties storage cannot save the snapshot, no playlist change is attempted.
After a partial removal failure, replacement maps are already present; retrying
continues reconciliation. The saved original IDs remain available for manual
recovery if needed.

First-time credentials are persisted only after login returns a session cookie.
Missing, corrupt or expired cookies trigger authentication recovery. Weekly
trigger setup retries after failure and avoids duplicate `run` handlers.

Update or regenerate existing Apps Script copies to adopt template changes. This
repository does not contain the deployed builder backend, and changing these
files does not update an existing script or deployment.

Run `npm ci --ignore-scripts` and `npm test` for local synthetic regression checks.
They execute the actual template and builder code with mocked services, temporary
properties, synthetic credentials and intercepted HTTP requests. They do not call
Google or BeatSaver, create triggers, or modify real playlists.
