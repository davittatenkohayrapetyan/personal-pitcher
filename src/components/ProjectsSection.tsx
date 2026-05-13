import projectsData from '../../data/projects.json';

const TECH_COLORS: Record<string, string> = {
  Go:         'bg-cyan-500/15 text-cyan-300 border-cyan-500/25',
  Kubernetes: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
  React:      'bg-sky-500/15 text-sky-300 border-sky-500/25',
  gRPC:       'bg-indigo-500/15 text-indigo-300 border-indigo-500/25',
  'Next.js':  'bg-slate-500/15 text-slate-300 border-slate-500/25',
  TypeScript: 'bg-blue-600/15 text-blue-200 border-blue-600/25',
  PostgreSQL: 'bg-green-500/15 text-green-300 border-green-500/25',
  Prisma:     'bg-teal-500/15 text-teal-300 border-teal-500/25',
  'Node.js':  'bg-lime-500/15 text-lime-300 border-lime-500/25',
  Redis:      'bg-red-500/15 text-red-300 border-red-500/25',
  Ollama:     'bg-violet-500/15 text-violet-300 border-violet-500/25',
  'Tailwind CSS': 'bg-teal-400/15 text-teal-200 border-teal-400/25',
};

const DEFAULT_TECH_COLOR = 'bg-slate-600/15 text-slate-300 border-slate-600/25';

export default function ProjectsSection() {
  return (
    <section className="py-16 sm:py-20 bg-slate-900 relative overflow-hidden">
      {/* Subtle background glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-600/5 rounded-full filter blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-600/5 rounded-full filter blur-3xl" />
      </div>

      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10 sm:mb-14">
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-white mb-3">
            Projects &amp; Builds
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto text-sm sm:text-base">
            Open source tools and platforms built to solve real developer problems.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-6">
          {projectsData.map((project) => (
            <a
              key={project.name}
              href={project.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group block bg-slate-800/60 border border-slate-700 hover:border-blue-500/50 rounded-2xl p-5 sm:p-6 transition-all duration-300 hover:shadow-xl hover:shadow-blue-900/20 hover:-translate-y-1"
            >
              <div className="flex items-start justify-between mb-3 gap-3">
                <h3 className="text-lg sm:text-xl font-bold text-white group-hover:text-blue-300 transition-colors">
                  {project.name}
                </h3>
                <svg className="w-5 h-5 text-slate-500 group-hover:text-blue-400 transition-colors flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </div>

              <p className="text-slate-400 text-sm leading-relaxed mb-4">
                {project.description}
              </p>

              {/* Tech stack */}
              <div className="flex flex-wrap gap-1.5 mb-4">
                {project.tech.map((t) => (
                  <span
                    key={t}
                    className={`px-2.5 py-0.5 text-xs font-medium rounded-full border ${TECH_COLORS[t] ?? DEFAULT_TECH_COLOR}`}
                  >
                    {t}
                  </span>
                ))}
              </div>

              {/* Highlights */}
              <ul className="space-y-1.5">
                {project.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2 text-xs text-slate-400">
                    <svg className="w-3.5 h-3.5 text-green-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    {h}
                  </li>
                ))}
              </ul>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
