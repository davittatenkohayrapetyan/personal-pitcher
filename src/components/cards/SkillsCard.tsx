'use client';

import { useState } from 'react';
import HighlightCard from '../HighlightCard';
import DetailsDialog from '../DetailsDialog';

/**
 * Grouped by *problem domain* rather than by language.
 *
 * The previous grouping ("Backend Engineering", "Frontend", "Databases") sorted
 * by technology family, which reads as a tool list and buries the fact that the
 * same person has shipped C++ and Verilog, Kotlin, Java and TypeScript. Sorting
 * by the problem being solved puts the durable skill first and the language
 * where it belongs — as an implementation detail.
 */
const DOMAINS: { name: string; blurb: string; items: string[] }[] = [
  {
    name: 'Resilience & Modernization',
    blurb: 'Keeping systems answering while they are being rebuilt underneath.',
    items: [
      'Monolith → microservices',
      'Fallback & circuit-breaker patterns',
      'Caching strategy (Redis)',
      'Distributed systems',
      'Enterprise integration',
      'System design',
    ],
  },
  {
    name: 'Data in Motion',
    blurb: 'Moving, searching and reconciling data across system boundaries.',
    items: [
      'Kafka',
      'IBM MQ',
      'Elasticsearch migration & tuning',
      'OracleDB',
      'PostgreSQL',
      'MongoDB',
      'MariaDB',
      'State-machine orchestration',
    ],
  },
  {
    name: 'AI Systems',
    blurb: 'Retrieval, routing and graceful degradation around models.',
    items: [
      'RAG & intent-routed retrieval',
      'Multi-provider LLM fallback',
      'AI agents',
      'Local LLM hosting (Ollama)',
      'AI-assisted developer tooling',
      'Intelligent automation',
    ],
  },
  {
    name: 'Operability',
    blurb: 'Knowing what production is doing before someone else tells you.',
    items: ['OpenTelemetry', 'Splunk', 'Structured logging', 'Docker · Swarm', 'Jenkins · CI/CD', 'AWS', 'Azure'],
  },
  {
    name: 'Languages Shipped to Production',
    blurb: 'Architecture-first, not language-first — the JVM is the deepest, not the boundary.',
    items: [
      'Java (13 yrs)',
      'Kotlin',
      'C++ · QT · Verilog (5 yrs, Synopsys)',
      'TypeScript · Angular · React',
      'JavaScript',
      'SQL',
    ],
  },
  {
    name: 'Leadership',
    blurb: 'The part that decides whether the architecture actually lands.',
    items: [
      'Architecture ownership',
      'Technical leadership',
      'Mentorship',
      'Engineering interviews',
      'Stakeholder communication',
      'University lecturing',
      'Community organization',
    ],
  },
];

const TOTAL = DOMAINS.reduce((acc, g) => acc + g.items.length, 0);

export default function SkillsCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HighlightCard
        icon={<span aria-hidden="true">🧩</span>}
        title="Skills by Problem"
        subtitle={`${DOMAINS.length} domains · ${TOTAL}+ capabilities`}
        description="Resilience, data in motion, AI systems, operability — with languages as an implementation detail."
        onClick={() => setOpen(true)}
      />
      <DetailsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Skills by Problem"
        description="Grouped by the problem being solved rather than by technology family."
      >
        <div className="space-y-5">
          {DOMAINS.map((domain) => (
            <section key={domain.name} aria-labelledby={`skills-${domain.name}`}>
              <h3
                id={`skills-${domain.name}`}
                className="text-xs font-semibold uppercase tracking-wide text-violet-300"
              >
                {domain.name}
              </h3>
              <p className="mb-2 mt-0.5 text-xs leading-relaxed text-slate-400">{domain.blurb}</p>
              <ul className="flex flex-wrap gap-1.5">
                {domain.items.map((s) => (
                  <li
                    key={s}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-200"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DetailsDialog>
    </>
  );
}
