import communityData from '../../data/community.json';

const { community } = communityData;
const org = community.organizations[0];

// Top events by attendee count
const FEATURED_EVENTS = [...community.events]
  .filter((e): e is typeof e & { attendees: number } => typeof e.attendees === 'number' && e.attendees >= 20)
  .sort((a, b) => b.attendees - a.attendees)
  .slice(0, 6);

export default function CommunitySection() {
  return (
    <section className="py-16 sm:py-20 bg-slate-800 relative overflow-hidden">
      {/* Subtle glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-10 right-10 w-72 h-72 bg-purple-600/5 rounded-full filter blur-3xl" />
      </div>

      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10 sm:mb-14">
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-white mb-3">
            Community &amp; Impact
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto text-sm sm:text-base">
            Organizing events, teaching, and growing the developer community in Armenia.
          </p>
        </div>

        {/* GDG Yerevan org banner */}
        <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5 sm:p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-4">
            <div className="flex items-center gap-3 flex-1">
              <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-400 text-xl flex-shrink-0">
                🏛️
              </div>
              <div>
                <h3 className="text-white font-bold text-lg leading-tight">{org.name}</h3>
                <p className="text-blue-400 text-sm">{org.role} · Since {org.since} · {org.location}</p>
              </div>
            </div>
            <div className="flex gap-6 sm:gap-8 sm:flex-shrink-0">
              <div className="text-center">
                <p className="text-white font-bold text-xl">{org.members.toLocaleString()}+</p>
                <p className="text-slate-400 text-xs">Members</p>
              </div>
              <div className="text-center">
                <p className="text-white font-bold text-xl">{org.events_count_visible_on_meetup}+</p>
                <p className="text-slate-400 text-xs">Events</p>
              </div>
              <div className="text-center">
                <p className="text-white font-bold text-xl">{org.rating}</p>
                <p className="text-slate-400 text-xs">Rating</p>
              </div>
            </div>
          </div>
          <p className="text-slate-400 text-sm leading-relaxed">{org.description}</p>
        </div>

        {/* Featured Events */}
        <div className="mb-6">
          <h3 className="text-white font-semibold text-base mb-4 px-1">Featured Events</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURED_EVENTS.map((event) => (
              <div key={event.name} className="bg-slate-900/60 border border-slate-700 rounded-xl p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <p className="text-slate-200 text-sm font-medium leading-tight">{event.name}</p>
                  <span className="flex-shrink-0 text-xs bg-blue-500/20 text-blue-300 border border-blue-500/30 rounded-full px-2 py-0.5 whitespace-nowrap">
                    {event.attendees} attendees
                  </span>
                </div>
                <p className="text-purple-400 text-xs mb-1">{event.role}</p>
                {'location' in event && event.location && (
                  <p className="text-slate-500 text-xs">{event.location}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Speaking & Mentoring + Topics */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-6">
          {/* Speaking & Mentoring */}
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl bg-green-500/20 flex items-center justify-center text-green-400 text-lg">
                🤝
              </div>
              <h3 className="text-white font-bold text-base">Speaking &amp; Mentoring</h3>
            </div>
            <ul className="space-y-4">
              {community.speaking_and_mentoring.map((item, i) => (
                <li key={i}>
                  <p className="text-slate-200 text-sm font-medium leading-tight mb-0.5">{item.type}</p>
                  {'organization' in item && (
                    <p className="text-green-400 text-xs mb-1">{item.organization}</p>
                  )}
                  <p className="text-slate-500 text-xs leading-snug">{item.description}</p>
                </li>
              ))}
            </ul>
          </div>

          {/* Topics */}
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg">
                💡
              </div>
              <h3 className="text-white font-bold text-base">Community Topics</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {community.topics.map((topic) => (
                <span
                  key={topic}
                  className="px-3 py-1 text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20 rounded-full"
                >
                  {topic}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
