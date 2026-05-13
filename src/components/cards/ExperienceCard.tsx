'use client';

import { useState } from 'react';
import HighlightCard from '../HighlightCard';
import DetailsDialog from '../DetailsDialog';

interface Role {
  company: string;
  title: string;
  period: string;
  description: string;
  highlights?: string[];
}

const ROLES: Role[] = [
  {
    company: 'Grid Dynamics',
    title: 'Staff Software Engineer',
    period: 'Jan 2025 — Present',
    description:
      'Leading modernization of Raymond James wealth-management platform: monolith → resilient microservices, observability, vendor integrations, performance.',
    highlights: ['Java 17 · Spring Boot · Redis', 'IBM MQ · OracleDB · OpenTelemetry'],
  },
  {
    company: 'jambit.am LLC',
    title: 'Principal Java Developer / Architect',
    period: '2022 — 2024',
    description:
      'Architecture leadership across backend platforms; speaker coordination, technical mentorship, and high-load distributed systems work.',
  },
  {
    company: 'jambit.am LLC',
    title: 'Senior Software Architect',
    period: '2020 — 2022',
    description:
      'Designed scalable backend services, owned architectural decisions, and mentored engineers across Java/Kotlin teams.',
  },
  {
    company: 'Talkdesk',
    title: 'Senior Software Engineer',
    period: '2018 — 2020',
    description:
      'Built backend services for a global cloud contact-center platform with a focus on scalability and reliability.',
  },
  {
    company: 'Novanoweb Solutions',
    title: 'Senior Software Engineer',
    period: '2017 — 2018',
    description: 'Backend engineering and integrations for enterprise web platforms.',
  },
  {
    company: 'Synopsys',
    title: 'Senior Software Engineer',
    period: '2015 — 2017',
    description: 'Backend systems engineering at scale within Synopsys engineering organization.',
  },
  {
    company: 'Inomma',
    title: 'Senior Software Engineer',
    period: '2014 — 2015',
    description: 'Full-stack and backend engineering on customer-facing products.',
  },
  {
    company: 'Synergy International Systems',
    title: 'Software Engineer',
    period: '2012 — 2014',
    description:
      'Started his professional engineering career building enterprise solutions and integrations.',
  },
];

const EDUCATION = [
  { degree: 'PhD in Engineering', school: 'Yerevan State University', year: '2019' },
  { degree: 'Master in Development of Information Systems', school: 'Yerevan State University', year: '2016' },
];

export default function ExperienceCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HighlightCard
        icon={<span aria-hidden="true">💼</span>}
        title="Experience & Education"
        subtitle={`${ROLES.length} roles · 13+ years`}
        description="Staff Software Engineer at Grid Dynamics. PhD in Engineering, Yerevan State University."
        onClick={() => setOpen(true)}
      />
      <DetailsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Experience & Education"
        description="Career timeline and academic background."
      >
        <section aria-labelledby="experience-heading">
          <h3 id="experience-heading" className="mb-3 text-sm font-semibold text-white">
            Experience
          </h3>
          <ol className="space-y-3 border-l border-white/10 pl-4">
            {ROLES.map((role, i) => (
              <li key={i} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-gradient-to-br from-violet-400 to-blue-400 ring-4 ring-slate-900"
                />
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="text-sm font-semibold text-white">{role.title}</p>
                    <p className="text-[11px] text-slate-400">{role.period}</p>
                  </div>
                  <p className="text-xs font-medium text-violet-300">{role.company}</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{role.description}</p>
                  {role.highlights && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {role.highlights.map((h) => (
                        <li
                          key={h}
                          className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300"
                        >
                          {h}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="education-heading" className="mt-6">
          <h3 id="education-heading" className="mb-3 text-sm font-semibold text-white">
            Education
          </h3>
          <ul className="space-y-2">
            {EDUCATION.map((e) => (
              <li
                key={e.degree}
                className="flex items-baseline justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3"
              >
                <div>
                  <p className="text-sm font-medium text-white">{e.degree}</p>
                  <p className="text-xs text-slate-400">{e.school}</p>
                </div>
                <span className="text-xs text-slate-500">{e.year}</span>
              </li>
            ))}
          </ul>
        </section>
      </DetailsDialog>
    </>
  );
}
