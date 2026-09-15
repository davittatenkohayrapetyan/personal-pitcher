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

// Dates, projects and technologies are kept in sync with `data/profile.md`,
// which is what the assistant answers from. They previously disagreed — the
// card and the chatbot gave different careers for the same person.
const ROLES: Role[] = [
  {
    company: 'Grid Dynamics',
    title: 'Staff Software Engineer',
    period: 'Jan 2025 — Present',
    description:
      'Leading modernization of the Raymond James wealth-management platform: legacy monoliths into resilient microservices, observability, vendor integrations, and caching-led performance work.',
    highlights: ['Java 17 · Spring Boot · Redis', 'IBM MQ · OracleDB · OpenTelemetry · Splunk'],
  },
  {
    company: 'jambit.am LLC',
    title: 'Principal Java Developer / Architect',
    period: 'Mar 2024 — Jan 2025',
    description:
      'Led development of a governmental mobile driver-license platform — resilient microservices, REST APIs, Angular frontend modules, and enrollment, encryption and document workflows.',
    highlights: ['Kotlin · Java 21 · Spring Boot', 'Angular · MongoDB · AWS · Docker Swarm'],
  },
  {
    company: 'jambit.am LLC',
    title: 'Senior Software Architect',
    period: 'Mar 2023 — Mar 2024',
    description:
      'Led enterprise Java synchronization systems for automotive material verification, owning reliability and architecture improvements.',
    highlights: ['Java EE · Payara · OracleDB', 'Azure · Swing · Angular'],
  },
  {
    company: 'Talkdesk',
    title: 'Senior Software Engineer',
    period: 'Jul 2021 — Oct 2022',
    description:
      'Designed scalable omnichannel survey microservices and proposed the state-machine-driven orchestration that the team standardized on.',
    highlights: ['Java 16 · Spring Boot · Redis', 'Kafka · Docker · Jenkins'],
  },
  {
    company: 'Novanoweb Solutions',
    title: 'Senior Software Engineer',
    period: 'Aug 2020 — Jul 2021',
    description:
      'Led the migration from relational databases to Elasticsearch, then optimized aggregation and search performance for e-commerce scale.',
    highlights: ['Java · Spring Boot · Elasticsearch', 'MariaDB · PostgreSQL'],
  },
  {
    company: 'Synopsys',
    title: 'Senior Software Engineer',
    period: 'Aug 2015 — Aug 2020',
    description:
      'Five years outside the JVM: embedded memory testing and repair systems, silicon production analysis tooling, and performance-sensitive low-level software.',
    highlights: ['C++ · QT · Verilog'],
  },
  {
    company: 'Inomma',
    title: 'Senior Software Engineer',
    period: 'Apr 2015 — Jul 2015',
    description: 'Built automated cloud-based competitor pricing scrapers.',
    highlights: ['Java · Spring Boot · AWS'],
  },
  {
    company: 'Synergy International Systems',
    title: 'Software Engineer',
    period: 'Sep 2011 — Apr 2015',
    description:
      'Started his professional engineering career enhancing CMS platforms for government organizations and integrating web and desktop systems.',
    highlights: ['Java EE · JSP · Swing', 'JavaScript · jQuery · MySQL'],
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
        description="Staff Engineer at Grid Dynamics. PhD in Engineering. Five of those years were C++ and Verilog, not Java."
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
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
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
                className="flex items-baseline justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4"
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
