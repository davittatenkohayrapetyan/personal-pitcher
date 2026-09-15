import type { FetchContext, RawPosting, SourceId } from '../types';
import { fetchWorkday } from './workday';
import { fetchPinpoint } from './pinpoint';
import { fetchGreenhouse } from './greenhouse';
import { fetchLever } from './lever';
import { fetchAshby } from './ashby';
import { fetchArbeitnow, fetchHimalayas, fetchRemoteOk, fetchRemotive } from './aggregators';

/**
 * Which adapter serves which source, in one table.
 *
 * It lived inside `index.ts` until the 07:00 discovery job needed the same
 * answer, and it moved rather than being copied for a specific reason: §9's
 * verification rule is "call the endpoint the monitoring code would call and
 * require a posting it can parse". Two tables would let those two drift, and
 * the drift is silent in the direction that matters — a new ATS adapter added
 * to the run loop and not here would mean discovery quietly refusing to propose
 * any company on the one board the system had just learned to read.
 */

export type Fetcher = (ctx: FetchContext) => Promise<RawPosting[]>;

/** Called once per company on the watch list. */
export const ATS_ADAPTERS: Partial<Record<SourceId, Fetcher>> = {
  workday: fetchWorkday,
  pinpoint: fetchPinpoint,
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
};

/** Called once for everyone. */
export const AGGREGATOR_ADAPTERS: Partial<Record<SourceId, Fetcher>> = {
  remotive: fetchRemotive,
  remoteok: fetchRemoteOk,
  arbeitnow: fetchArbeitnow,
  himalayas: fetchHimalayas,
};
