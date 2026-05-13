import communityData from '../../data/community.json';

const org = communityData.community.organizations[0];

const STATS = [
  { value: '13+', label: 'Years Experience' },
  { value: `${org.events_count_visible_on_meetup}+`, label: 'GDG Events' },
  { value: '9+', label: 'Companies Served' },
  { value: '2', label: 'Advanced Degrees' },
];

export default function StatsGrid() {
  return (
    <section aria-label="Career statistics" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {STATS.map((stat) => (
        <div
          key={stat.label}
          className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 text-center"
        >
          <p className="text-xl font-bold text-white sm:text-2xl">{stat.value}</p>
          <p className="mt-0.5 text-[11px] leading-tight text-slate-400 sm:text-xs">{stat.label}</p>
        </div>
      ))}
    </section>
  );
}
