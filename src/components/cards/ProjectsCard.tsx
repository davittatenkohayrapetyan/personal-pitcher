'use client';

import { useState } from 'react';
import projectsData from '../../../data/projects.json';
import HighlightCard from '../HighlightCard';
import DetailsDialog from '../DetailsDialog';

export default function ProjectsCard() {
  const [open, setOpen] = useState(false);

  const projects = projectsData.projects ?? projectsData;

  return (
    <>
      <HighlightCard
        icon={<span aria-hidden="true">🛠️</span>}
        title="Projects & Builds"
        subtitle={`${projects.length} project${projects.length === 1 ? '' : 's'}`}
        description="Open source tools and platforms — including this AI portfolio site itself."
        badge="Open source"
        onClick={() => setOpen(true)}
      />
      <DetailsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Projects & Builds"
        description="Open source tools and platforms built to solve real developer problems."
      >
        <ul className="space-y-5">
          {projects.map((project) => (
            <li
              key={project.name}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold text-white">{project.name}</h3>
                {project.url ? (
                  <a
                    href={project.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-violet-200 transition-colors hover:bg-violet-500/10 hover:text-white"
                    aria-label={`Open ${project.name} repository in a new tab`}
                  >
                    Repo
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </a>
                ) : (
                  <span className="inline-flex items-center rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-500">
                    Private
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{project.description}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {project.tech.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <ul className="mt-3 space-y-1.5">
                {project.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2 text-xs text-slate-400">
                    <span aria-hidden="true" className="mt-0.5 text-emerald-400">✓</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </DetailsDialog>
    </>
  );
}
