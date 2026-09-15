import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { FetchCache } from './types';
import { CACHE_DIR, cacheTtlMs } from './config';
import { logger } from '../logger';

/**
 * The feed cache the 07:00 and 08:00 jobs share (§11, §17.7).
 *
 * Both jobs read the same aggregator feeds — one to find companies worth
 * watching, one to find roles — and within an hour those responses are
 * identical. So the earlier job's read is written to disk and the later one
 * starts with its cheapest source already local, spending more of its hour on
 * the Mac and less on HTTP.
 *
 * ## It is a cache, not a contract
 *
 * A cold or expired entry just means an HTTP call. Neither job fails if the
 * other never ran, and nothing downstream can tell the difference apart from
 * one log line. That is why every failure mode here — unreadable file, corrupt
 * JSON, unwritable directory — degrades to "fetch it" rather than throwing: a
 * broken cache must never be able to break a run.
 *
 * ## What is not cached, and why
 *
 * Only aggregator GETs. Never a Workday POST: the whole point of the bot
 * management in front of that endpoint is that it is watching request
 * behaviour, and a replayed request is meaningless to it and dishonest of us.
 * Never a posting detail fetched for stage A either — that is read once, by one
 * stage, and caching it would keep untrusted employer prose on disk long after
 * the only stage allowed to read it has finished.
 *
 * Enforcement is by construction rather than by rule: this object exposes one
 * GET-shaped method, so an adapter that must not be cached calls `fetch`
 * directly and the difference is visible in its source.
 */

interface CacheEntry {
  url: string;
  /** Of the body, so "did the feed actually change?" is answerable from two entries. */
  bodyHash: string;
  fetchedAt: string;
  status: number;
  body: string;
}

function entryPath(method: string, url: string, body: string): string {
  const key = crypto
    .createHash('sha256')
    .update(`${method}${url}${body}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(CACHE_DIR, `${key}.json`);
}

function readEntry(file: string): CacheEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheEntry;
    return typeof parsed?.body === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeEntry(file: string, entry: CacheEntry): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf-8');
  } catch (err) {
    // A cache that cannot write is a cache that is slow, not a run that failed.
    logger.warn('outreach_cache_write_failed', {
      file,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function discard(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone is the desired end state. A delete that loses a race with
    // another run has still got what it wanted.
  }
}

export interface CacheOptions {
  /** Ignore what is on disk and refetch. Used by `--no-cache`. */
  bypass?: boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Deletes every expired entry, once per run.
 *
 * Reclaiming on read is not enough, and §17.7's claim that the directory "does
 * not grow without bound" was false without this: an entry is only ever
 * re-requested if the same URL comes round again, and Himalayas pages by a
 * keyset cursor that changes the moment a job is posted. Every run therefore
 * orphaned a file or two that nothing would ever ask for again. A sweep is one
 * `readdir` against a directory holding a handful of files.
 */
function sweep(ttlMs: number, log: (event: string, fields: Record<string, unknown>) => void): void {
  let reclaimed = 0;

  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (!name.endsWith('.json')) continue;

      const file = path.join(CACHE_DIR, name);
      const entry = readEntry(file);
      const ageMs = entry ? Date.now() - Date.parse(entry.fetchedAt) : Infinity;

      // An unreadable or undated entry is swept too: it can never produce a hit,
      // so keeping it costs a file and buys nothing.
      if (!Number.isFinite(ageMs) || ageMs >= ttlMs) {
        discard(file);
        reclaimed += 1;
      }
    }
  } catch {
    // No directory yet, or no permission to read it. Both mean there is nothing
    // to reclaim, and neither is a reason to stop a run before it starts.
    return;
  }

  if (reclaimed > 0) log('outreach_cache_swept', { reclaimed });
}

/**
 * Opens the shared cache.
 *
 * The TTL is read once per run rather than per call, so a run behaves
 * consistently even if the environment changes under it, and the expired
 * entries are swept here rather than lazily on read — see `sweep`.
 */
export function openCache(options: CacheOptions = {}): FetchCache {
  const ttl = cacheTtlMs();
  const log = options.log ?? ((event, fields) => logger.info(event, fields));

  sweep(ttl, log);

  return {
    async json<T>(url: string, init: { headers?: Record<string, string> } = {}): Promise<T> {
      const file = entryPath('GET', url, '');

      if (!options.bypass) {
        const entry = readEntry(file);
        if (entry) {
          const ageMs = Date.now() - Date.parse(entry.fetchedAt);
          if (Number.isFinite(ageMs) && ageMs < ttl) {
            log('outreach_cache_hit', { url, ageMs, bodyHash: entry.bodyHash });
            return JSON.parse(entry.body) as T;
          }
          discard(file);
        }
      }

      const response = await fetch(url, { headers: init.headers });
      const body = await response.text();

      if (!response.ok) {
        // Deliberately not cached. A 503 stored for 90 minutes is 90 minutes of
        // a source being silently absent, and the next run should ask again.
        throw new Error(`${response.status} ${response.statusText} for ${url}`);
      }

      const parsed = JSON.parse(body) as T;

      writeEntry(file, {
        url,
        bodyHash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
        fetchedAt: new Date().toISOString(),
        status: response.status,
        body,
      });

      return parsed;
    },
  };
}
