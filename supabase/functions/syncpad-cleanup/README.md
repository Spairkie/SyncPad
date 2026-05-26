# SyncPad Cleanup Edge Function

Optional service-role maintenance function for Supabase Storage cleanup.

## What It Does

- `mode: "expired"` removes known Storage objects for expired rooms, then calls `cleanup_expired_syncpad_rooms()`.
- `mode: "orphans"` lists objects in the `syncpad-files` bucket and removes objects whose path is no longer present in `syncpad_files.file_path`.
- `mode: "all"` runs both steps.
- `dryRun: true` reports counts without deleting anything. This is the default.

The function only logs aggregate counts. It does not read file contents.

## Required Secrets

Supabase provides these to deployed Edge Functions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Set this project-specific secret yourself:

```bash
supabase secrets set SYNCPAD_CLEANUP_SECRET="use-a-long-random-value"
```

## Deploy

```bash
supabase functions deploy syncpad-cleanup --no-verify-jwt
```

The function performs its own shared-secret authorization so it can be called by cron/scheduler tooling. Do not expose `SYNCPAD_CLEANUP_SECRET`.

## Invoke

```bash
curl -X POST "https://YOUR-PROJECT-REF.functions.supabase.co/syncpad-cleanup" \
  -H "Authorization: Bearer $SYNCPAD_CLEANUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"all","dryRun":true}'
```

Run with `dryRun:false` only after reviewing the dry-run output.
