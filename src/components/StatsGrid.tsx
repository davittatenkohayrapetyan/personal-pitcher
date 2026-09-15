import communityData from '../../data/community.json';

const org = communityData.community.organizations[0];

/**
 * Stats are chosen to read as *outcomes and credentials*, not tenure.
 *
 * "Companies Served" was cut on purpose: a count of employers reads as a
 * staffing history, which is the opposite of the ownership signal this row is
 * meant to carry.
 */
const STATS = [
  { value: 'PhD', label: 'Engineering · Yerevan State University', accent: true },
  { value: '13+', label: 'Years designing distributed systems' },
  { value: '4', label: 'Languages shipped to production' },
  {
    value: org.members.toLocaleString('en-US'),
    label: 'Developers in the community he runs',
  },
];

export default function StatsGrid() {
  return (
    <section aria-label="Career highlights" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {STATS.map((stat) => (
        <div
          key={stat.label}
          className={`rounded-2xl border px-5 py-5 text-center ${
            stat.accent
              ? 'border-violet-400/30 bg-violet-500/[0.08]'
              : 'border-slate-400/15 bg-slate-900/70'
          }`}
        >
          <p
            className={`text-3xl font-bold sm:text-4xl ${
              stat.accent ? 'text-violet-200' : 'text-white'
            }`}
          >
            {stat.value}
          </p>
          <p className="mt-1 text-xs leading-tight text-slate-400">{stat.label}</p>
        </div>
      ))}
    </section>
  );
}
