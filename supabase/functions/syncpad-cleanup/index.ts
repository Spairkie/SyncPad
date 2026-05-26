import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BUCKET = 'syncpad-files';
const BATCH_SIZE = 100;
const PAGE_SIZE = 1000;

type CleanupMode = 'expired' | 'orphans' | 'all';

type JsonRecord = Record<string, unknown>;
type SupabaseAdminClient = SupabaseClient<any, 'public', 'public', any, any>;

function json(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function authorize(req: Request): boolean {
  const secret = Deno.env.get('SYNCPAD_CLEANUP_SECRET');
  if (!secret) return false;
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const explicit = req.headers.get('x-syncpad-cleanup-secret');
  return bearer === secret || explicit === secret;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function selectAll<T>(
  queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await queryFactory(from, to);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function listBucketPaths(sb: SupabaseAdminClient, prefix = ''): Promise<string[]> {
  const found: string[] = [];

  async function walk(path: string): Promise<void> {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await sb.storage.from(BUCKET).list(path, {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw error;
      const entries = data ?? [];

      for (const entry of entries) {
        const childPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.id === null) await walk(childPath);
        else found.push(childPath);
      }

      if (entries.length < PAGE_SIZE) break;
    }
  }

  await walk(prefix.replace(/^\/+|\/+$/g, ''));
  return found;
}

async function removeStorageObjects(
  sb: SupabaseAdminClient,
  paths: string[],
  dryRun: boolean,
): Promise<{ requested: number; removed: number }> {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  if (dryRun || unique.length === 0) return { requested: unique.length, removed: 0 };

  let removed = 0;
  for (const batch of chunk(unique, BATCH_SIZE)) {
    const { error } = await sb.storage.from(BUCKET).remove(batch);
    if (error) throw error;
    removed += batch.length;
  }
  return { requested: unique.length, removed };
}

async function cleanupExpired(sb: SupabaseAdminClient, dryRun: boolean) {
  const nowIso = new Date().toISOString();
  const expiredRooms = await selectAll<{ room_id: string; encryption_enabled: boolean }>((from, to) =>
    sb
      .from('syncpad_rooms')
      .select('room_id,encryption_enabled')
      .not('expires_at', 'is', null)
      .lte('expires_at', nowIso)
      .range(from, to)
  );

  const roomIds = expiredRooms.map((room) => room.room_id);
  const encryptedRoomIds = expiredRooms
    .filter((room) => room.encryption_enabled)
    .map((room) => room.room_id);

  const fileRows = encryptedRoomIds.length
    ? await selectAll<{ file_path: string }>((from, to) =>
        sb
          .from('syncpad_files')
          .select('file_path')
          .in('room_id', encryptedRoomIds)
          .range(from, to)
      )
    : [];

  const storage = await removeStorageObjects(
    sb,
    fileRows.map((row) => row.file_path),
    dryRun,
  );

  let dbResult: unknown = null;
  if (!dryRun) {
    const { data, error } = await sb.rpc('cleanup_expired_syncpad_rooms');
    if (error) throw error;
    dbResult = data;
  }

  return {
    expiredRooms: roomIds.length,
    encryptedExpiredRooms: encryptedRoomIds.length,
    storageObjects: storage,
    databaseCleanup: dryRun ? 'dry-run skipped' : dbResult,
  };
}

async function cleanupOrphans(sb: SupabaseAdminClient, dryRun: boolean) {
  const trackedRows = await selectAll<{ file_path: string }>((from, to) =>
    sb.from('syncpad_files').select('file_path').range(from, to)
  );
  const tracked = new Set(trackedRows.map((row) => row.file_path).filter(Boolean));
  const stored = await listBucketPaths(sb);
  const orphanPaths = stored.filter((path) => !tracked.has(path));
  const storage = await removeStorageObjects(sb, orphanPaths, dryRun);

  return {
    trackedObjects: tracked.size,
    storedObjects: stored.length,
    orphanObjects: orphanPaths.length,
    storageObjects: storage,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  if (!authorize(req)) {
    return json({ error: 'Unauthorized cleanup request' }, 401);
  }

  try {
    const body = await req.json().catch(() => ({})) as {
      dryRun?: boolean;
      mode?: CleanupMode;
    };
    const dryRun = body.dryRun !== false;
    const mode = body.mode ?? 'all';
    if (!['expired', 'orphans', 'all'].includes(mode)) {
      return json({ error: 'mode must be "expired", "orphans", or "all"' }, 400);
    }

    const sb = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const result: JsonRecord = { dryRun, mode };
    if (mode === 'expired' || mode === 'all') {
      result.expired = await cleanupExpired(sb, dryRun);
    }
    if (mode === 'orphans' || mode === 'all') {
      result.orphans = await cleanupOrphans(sb, dryRun);
    }

    return json(result);
  } catch (err) {
    console.error('[syncpad-cleanup]', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
