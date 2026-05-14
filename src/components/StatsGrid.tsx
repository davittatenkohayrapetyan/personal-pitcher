import communityData from '../../data/community.json';
import projectsData from '../../data/projects.json';

const org = communityData.community.organizations[0];
const projectCount = (projectsData.projects ?? projectsData).length;

const STATS = [
  { value: '13+', label: 'Years Experience' },
  { value: `${org.events_count_visible_on_meetup}+`, label: 'GDG Events' },
  { value: '9+', label: 'Companies Served' },
  { value: `${projectCount}+`, label: 'Public Projects' },
];

export default function StatsGrid() {
  return (
    <section aria-label="Career statistics" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {STATS.map((stat) => (
        <div
          key={stat.label}
          className="rounded-2xl border border-slate-400/15 bg-slate-900/70 px-5 py-5 text-center"
        >
          <p className="text-3xl font-bold text-white sm:text-4xl">{stat.value}</p>
          <p className="mt-1 text-xs leading-tight text-slate-400">{stat.label}</p>
        </div>
      ))}
    </section>
  );
}
