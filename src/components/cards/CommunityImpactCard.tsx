'use client';

import { useState } from 'react';
import communityData from '../../../data/community.json';
import HighlightCard from '../HighlightCard';
import DetailsDialog from '../DetailsDialog';

const { community } = communityData;
const org = community.organizations[0];

const FEATURED_EVENTS = [...community.events]
  .filter((e): e is typeof e & { attendees: number } =>
    typeof e.attendees === 'number' && e.attendees >= 20,
  )
  .sort((a, b) => b.attendees - a.attendees);

export default function CommunityImpactCard() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <HighlightCard
        icon={<span aria-hidden="true">🏛️</span>}
        title="Community Impact"
        subtitle={`${org.name} · ${org.role} since ${org.since}`}
        description={`${org.members.toLocaleString()}+ members, ${org.events_count_visible_on_meetup}+ events organized.`}
        badge="GDG"
        onClick={() => setOpen(true)}
      />
      <DetailsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Community & Impact"
        description={`${org.name} — ${org.role} since ${org.since}`}
      >
        <div className="space-y-6">
          <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-3 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-xl font-bold text-white">{org.members.toLocaleString()}+</p>
                <p className="text-[11px] text-slate-400">Members</p>
              </div>
              <div>
                <p className="text-xl font-bold text-white">{org.events_count_visible_on_meetup}+</p>
                <p className="text-[11px] text-slate-400">Events</p>
              </div>
              <div>
                <p className="text-xl font-bold text-white">{org.rating}</p>
                <p className="text-[11px] text-slate-400">Rating</p>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-slate-400">{org.description}</p>
          </section>

          <section aria-labelledby="featured-events-heading">
            <h3 id="featured-events-heading" className="mb-3 text-sm font-semibold text-white">
              Featured events
            </h3>
            <ul className="space-y-2">
              {FEATURED_EVENTS.map((event) => (
                <li
                  key={event.name}
                  className="rounded-lg border border-white/10 bg-white/[0.02] p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-slate-100">{event.name}</p>
                    <span className="flex-shrink-0 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-200">
                      {event.attendees}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-violet-300">{event.role}</p>
                  {'location' in event && event.location && (
                    <p className="text-[11px] text-slate-500">{event.location}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="speaking-heading">
            <h3 id="speaking-heading" className="mb-3 text-sm font-semibold text-white">
              Speaking & mentoring
            </h3>
            <ul className="space-y-3">
              {community.speaking_and_mentoring.map((item, i) => (
                <li key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
                  <p className="text-sm font-medium text-slate-100">{item.type}</p>
                  {'organization' in item && (
                    <p className="text-[11px] text-emerald-300">{item.organization}</p>
                  )}
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{item.description}</p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="topics-heading">
            <h3 id="topics-heading" className="mb-3 text-sm font-semibold text-white">
              Topics
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {community.topics.map((t) => (
                <li
                  key={t}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-300"
                >
                  {t}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DetailsDialog>
    </>
  );
}
