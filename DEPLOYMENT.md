# SyncPad — Deployment Guide

> ⚠️ **Personal / demo project.**  
> Room links are frontend-restricted, not backend-secret — anyone who knows or guesses a room's URL can view **and edit** it. `?mode=read` and `/share/:token` read-only links are a UI convention, not a hard server-side boundary (see [Security reminder](#security-reminder) below). The room lock feature is the one control that's actually server-enforced.  
> View-once is still a convenience feature, not a secure destruction guarantee. A viewer may copy, screenshot, save, or otherwise preserve content before it clears.  
> Do **not** deploy SyncPad for use with passwords, HIPAA/PII, classified data, or anything sensitive.

---

## Prerequisites

- A [Supabase](https://supabase.com) project (free tier works)
- A GitHub account with GitHub Pages enabled

---

## Base path

SyncPad is deployed at `/SyncPad` on GitHub Pages. The runtime base path is configured in `index.html`:

```html
window.SYNCPAD_CONFIG = {
  basePath: '/SyncPad',
  ...
};
```

`src/app.js` reads this value and `service-worker.js` derives its base from the service worker registration scope. The static HTML links, `manifest.json`, and `404.html` still use `/SyncPad` because GitHub Pages is the permanent deployment target.

**To host at the root** (custom domain, Vercel, Netlify, etc.):
1. Change `window.SYNCPAD_CONFIG.basePath` to `''`.
2. Update `manifest.json`: `"start_url": "/"` and `"scope": "/"`.
3. Replace `/SyncPad/` static prefixes in `index.html` with `/`.
4. Update the `404.html` redirect script or use the host's SPA rewrite support.

---

## Step 1 — Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Note your **Project URL** and **anon public key** from Settings → API
3. Optional: enable the `pg_cron` extension (Database → Extensions) for automatic expired-room cleanup

---

## Step 2 — Database and storage setup

SyncPad's SQL lives in `supabase/migrations/`, one file per migration, numbered in the order they must be run — the standard layout for a project without a migration-tracking tool (and the same path the Supabase CLI would use, if this project ever adopts it). Numbered files, not one merged file: each one stays independently reviewable and keeps its own git history, and the number makes run-order unambiguous without needing a tracking table. All of them are **idempotent** — safe to rerun on an existing project.

In the Supabase **SQL Editor**, run:

1. **[`supabase/migrations/0001_base_schema.sql`](supabase/migrations/0001_base_schema.sql)** — the base schema, and the only migration a brand-new project actually needs. Creates:
   - `syncpad_rooms` and `syncpad_files` tables, indexes, Realtime publication entries
   - Row Level Security (RLS) policies — `room_id` + the anon key is sufficient to read and write a room
   - `cleanup_expired_syncpad_rooms()` and an optional `pg_cron` schedule (every 10 minutes, skipped gracefully if pg_cron isn't enabled)
   - A trigger enforcing the room editing lock (`editing_locked`) at the database level — this is the one access control that's actually server-enforced
   - `syncpad-files` Storage bucket (private) + Storage RLS policies

If you previously deployed with the edit-token migrations (`0007_room_edit_tokens.sql`), also run **[`supabase/migrations/0009_revert_edit_token_write_gating.sql`](supabase/migrations/0009_revert_edit_token_write_gating.sql)** to restore normal write access — see that file's header for why the edit-token model was reverted. A fresh project that never ran `0007` doesn't need `0009` either.

The optional Storage cleanup Edge Function lives at `supabase/functions/syncpad-cleanup` and is deployed separately with the Supabase CLI. It is not installed by the SQL scripts.

> **Important:** The bucket is private. SyncPad always accesses files via signed URLs. Do not make the bucket public.

### Optional feature migrations

These genuinely are opt-in — the app works without them, and each feature just silently no-ops (or shows a "check Supabase setup" error) until its migration is run. Run `0001` first, then any of these you want, in any order:

| Migration | Enables | Symptom if skipped |
|---|---|---|
| [`supabase/migrations/0002_short_room_codes.sql`](supabase/migrations/0002_short_room_codes.sql) | Short (6-character) spoken/typed room codes — the "Short code" row in the Share modal, and typing a code into the landing page's join box | Share modal shows "Short codes need one more setup step…"; typing a code on the landing page falls through to treating it as a literal room id instead of resolving it |
| [`supabase/migrations/0003_room_comments.sql`](supabase/migrations/0003_room_comments.sql) | Anchored inline comments on a text range (Comments panel) | Comments panel loads with no comments and no error — the feature is silently unavailable |
| [`supabase/migrations/0004_version_history.sql`](supabase/migrations/0004_version_history.sql) | Version History panel — browse and restore past snapshots of a room | History panel shows no snapshots |
| [`supabase/migrations/0005_device_limit.sql`](supabase/migrations/0005_device_limit.sql) | "Burn after N devices join" room setting | The device-limit setting has no effect; `device_limit` stays `null` |
| [`supabase/migrations/0006_admin_dashboard_improvements.sql`](supabase/migrations/0006_admin_dashboard_improvements.sql) | Admin audit log, room quarantine, and disabled-downloads support in `/admin` | Those admin actions are unavailable; the rest of `/admin` still works |
| [`supabase/migrations/0008_quarantine_enforcement.sql`](supabase/migrations/0008_quarantine_enforcement.sql) | Server-enforced quarantine — a database trigger, same technique as room lock; requires `0006` first | Quarantine still works from `/admin`, but (as documented in `0006`'s own header) is frontend-only without this — a determined user could bypass it by calling the API directly |
| [`supabase/migrations/0007_room_edit_tokens.sql`](supabase/migrations/0007_room_edit_tokens.sql) | Historical/optional — the edit-token table and RPCs, unused by the current client (see `0009`'s header). Only relevant if you want to build something else on top of it | Nothing — this is inert infrastructure, not a live feature |

If a feature you expect to see doesn't work, re-check that its migration was actually run — the Supabase SQL Editor's query history shows past runs.

---

## Step 3 — Configure credentials

Open `index.html` and replace the placeholder credentials:

```html
<script>
  window.SYNCPAD_CONFIG = {
    supabaseUrl:     'https://YOUR-PROJECT-REF.supabase.co',
    supabaseAnonKey: 'YOUR-ANON-PUBLIC-KEY',
  };
</script>
```

The anon key is public-facing by design in Supabase. RLS policies (installed by `supabase/migrations/0001_base_schema.sql`) control what the anon role can actually do.

---

## Step 4 — Deploy to GitHub Pages

1. Push the repository to GitHub (the entire project root, no build needed)
2. **Settings → Pages → Source:** Deploy from a branch → `main` → `/` (root)
3. GitHub deploys to `https://YOUR-USERNAME.github.io/SyncPad/`

The `404.html` file handles SPA routing: unknown paths store the room ID in `sessionStorage`, then redirect to the app root so the correct room loads.

### Alternative hosting

SyncPad deploys to any static host — Vercel, Netlify, Cloudflare Pages, or any CDN. No server-side logic is needed. Just set the publish directory to the repo root and configure the rewrite rule to serve `index.html` for all paths. Then update the configured base path and static asset prefixes as described above.

---

## Step 5 — Verify deployment

After deploying, confirm these work in a browser:

- [ ] Landing screen loads at the root URL
- [ ] Creating a room redirects to `/<roomId>`
- [ ] Joining a room by URL works
- [ ] Hard-refreshing a room URL loads correctly (404.html redirect)
- [ ] Read-only share link (`/SyncPad/share/:token`) opens in read-only mode
- [ ] Uploading a file works
- [ ] Downloading a file works
- [ ] Two browser tabs show each other in the Devices panel
- [ ] Typing in one tab shows the indicator in the other

---

## Scheduled cleanup

### Expired rooms (Postgres-side)

If `pg_cron` is enabled, the SQL setup schedules a job every 10 minutes:

```sql
-- Verify the job exists
SELECT jobid, jobname, schedule, active
FROM   cron.job
WHERE  jobname = 'syncpad-expired-room-cleanup';

-- Run manually at any time
SELECT * FROM public.cleanup_expired_syncpad_rooms();
```

Unencrypted expired rooms are cleared in place. Encrypted expired rooms are deleted (the DB cannot recreate the encrypted empty payload without the user's passphrase).

### Storage orphan cleanup

Deleting a `syncpad_rooms` row cascades the `syncpad_files` metadata rows via `ON DELETE CASCADE`. It does **not** remove the physical objects in the `syncpad-files` Storage bucket unless the deletion path explicitly calls the Storage API.

The admin UI now removes known Storage objects before deleting rooms. For backend cleanup paths, deploy the optional service-role Edge Function:

```bash
# From a machine with the Supabase CLI configured for this project
supabase secrets set SYNCPAD_CLEANUP_SECRET="use-a-long-random-value"
supabase functions deploy syncpad-cleanup --no-verify-jwt

# Dry run first
curl -X POST "https://YOUR-PROJECT-REF.functions.supabase.co/syncpad-cleanup" \
  -H "Authorization: Bearer $SYNCPAD_CLEANUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"all","dryRun":true}'

# Real cleanup after reviewing counts
curl -X POST "https://YOUR-PROJECT-REF.functions.supabase.co/syncpad-cleanup" \
  -H "Authorization: Bearer $SYNCPAD_CLEANUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"all","dryRun":false}'
```

Supported modes are `expired`, `orphans`, and `all`. The function logs aggregate counts only and never reads file contents. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only; never add it to `index.html`.

For manual auditing, list known metadata paths:

```sql
SELECT room_id, file_path, filename, file_size
FROM   syncpad_files
ORDER  BY room_id, uploaded_at;
```

Then compare those paths with Supabase Dashboard -> Storage -> `syncpad-files`. Delete only confirmed orphaned objects.

> Always verify before deleting. There is no undo for deleted storage objects.

---


## Web3Forms operations (Contact page)

SyncPad's contact form uses Web3Forms from frontend JavaScript. The Web3Forms access key is a **public frontend key**, not a server secret.

Recommended Web3Forms dashboard settings:

- **Allowed domain:** `spairkie.github.io`
- **Subject:** `New SyncPad Contact Form Submission`
- **from_name:** `SyncPad Contact Form`
- **hCaptcha:** keep **off** unless the frontend adds an hCaptcha widget and verification flow

Operational note: keep the botcheck honeypot enabled and verify report-table DB constraints (reason allowlist + details length) and RLS posture before each public release.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Blank page on load | Wrong base path | Check `window.SYNCPAD_CONFIG.basePath`, static asset prefixes, and service worker scope |
| "Could not load room" | Wrong Supabase credentials | Check `supabaseUrl` and `supabaseAnonKey` in `index.html` |
| Files not uploading | Storage bucket missing or wrong RLS | Re-run `supabase/migrations/0001_base_schema.sql`; verify bucket policies |
| Realtime not syncing | Supabase Realtime not enabled | Dashboard → Database → Replication → enable both tables |
| Expired rooms not cleared | `pg_cron` not enabled | Enable `pg_cron` extension; re-run `supabase/migrations/0001_base_schema.sql` |
| App serving old cached content | Stale service worker | Bump `CACHE_VERSION` in `service-worker.js`; redeploy |
| Room URL 404 on hard refresh | `404.html` not present | Ensure `404.html` is in the repo root and deployed |
| Mobile "Add to Home Screen" fails | Wrong manifest paths | Verify `/SyncPad/` prefix in `manifest.json` icons |
| Room creation fails after visiting `/admin` | Missing authenticated RLS policies | Re-run `supabase/migrations/0001_base_schema.sql` — the authenticated baseline policies section fixes this |

---

## Service worker cache versioning

The service worker uses a named cache. To force clients to download fresh assets after cached files change:

1. Bump `CACHE_NAME` in `service-worker.js`
2. Deploy
3. On next load, old caches are purged and fresh assets are fetched

Current value at the time of this update: `syncpad-v10`.

---

## Security reminder

| Control | Enforcement |
|---|---|
| Read-only links (`?mode=read`, `/share/:token`) | **Frontend-only** — a UI/UX convention, not a server boundary. `room_id` + the anon key is sufficient to write regardless of which link was used; a read-only viewer necessarily learns `room_id` from viewing the room's content, so a technical visitor could call the write path directly. Use room lock for an actual guarantee |
| Room lock | **Backend-enforced** — a database trigger (`syncpad_rooms_enforce_lock`, installed by `supabase/migrations/0001_base_schema.sql`) rejects content changes to a locked room regardless of what calls the API |
| Room quarantine (optional, `/admin`) | **Backend-enforced** if `0008_quarantine_enforcement.sql` is applied — same trigger technique as room lock; frontend-only otherwise (see `0006`'s header) |
| `/admin` route | Supabase Auth (`signInWithPassword`) + `is_syncpad_admin()` RLS — not a public-facing feature |
| Passcode | Client-side hash check |
| Text encryption | In-browser (AES-256-GCM) |
| File access | Signed URLs (1 h TTL) — no end-to-end encryption |

Room links, passcode hashes, and file signed URLs are all controls a determined user with the anon key can get around on their own terms (see `docs/security.md`'s Known Limitations). Do not use SyncPad for sensitive data regardless — room lock is the only hard guarantee this app makes.

### Admin session and RLS roles

The Supabase JS client uses a single shared instance. After a user signs in at `/admin`, the client's session role changes from `anon` to `authenticated`. This means the anon RLS policies for `syncpad_rooms`, `syncpad_files`, and `storage.objects` no longer apply — they only match the `anon` role.

To prevent normal app features from breaking after admin login, `supabase/migrations/0001_base_schema.sql` adds mirrored **authenticated baseline** policies for all three that grant the same permissions as the anon policies. These are not privileged — they only allow what anon already could do. Admin-only destructive actions (delete rooms, etc.) are still gated by `is_syncpad_admin()` in separate admin policies.
