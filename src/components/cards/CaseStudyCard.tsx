'use client';

import { useState } from 'react';
import HighlightCard from '../HighlightCard';
import DetailsDialog from '../DetailsDialog';

/**
 * Every other card on this page is a *list*. None of them is a *story*, and
 * ownership only reads through story — "led X" in a bullet is a claim, whereas
 * Problem → Constraint → Decision → Outcome is evidence of having made calls.
 *
 * Both studies are drawn strictly from `data/profile.md`; nothing here asserts
 * an outcome that is not already recorded there.
 */

interface CaseStudy {
  id: string;
  label: string;
  title: string;
  context: string;
  problem: string;
  constraint: string;
  decisions: string[];
  outcome: string;
  stack: string[];
}

const STUDIES: CaseStudy[] = [
  {
    id: 'wealth-modernization',
    label: 'Grid Dynamics · 2025 — present',
    title: 'Modernizing a wealth-management platform without pausing it',
    context:
      'A wealth-management platform — a mission-critical system carrying live financial workflows.',
    problem:
      'Legacy monoliths had to become resilient microservices, while a platform that advisors depend on daily kept running.',
    constraint:
      'No greenfield rewrite, third-party financial data providers with their own failure modes, and enterprise messaging and database estates that could not simply be replaced.',
    decisions: [
      'Decompose the monolith incrementally rather than through a big-bang cutover.',
      'Implement resiliency patterns aimed specifically at preventing cascading failures between the new services.',
      'Design explicit fallback strategies for vendor integrations instead of assuming provider availability.',
      'Treat observability as part of the migration, not a follow-up — OpenTelemetry and Splunk alongside the decomposition.',
      'Use Redis and intelligent caching as the performance lever rather than premature service-level rewrites.',
    ],
    outcome:
      'Resiliency patterns preventing cascading failures, fallback strategies and observability improvements shipped, and architectural alignment held across engineering, DevOps, DBA and product.',
    stack: ['Java 17', 'Spring Boot', 'Redis', 'IBM MQ', 'OracleDB', 'OpenTelemetry', 'Splunk'],
  },
  {
    id: 'search-migration',
    label: 'Novanoweb · 2020 — 2021',
    title: 'Taking e-commerce search off the relational database',
    context: 'E-commerce platform whose search and aggregation load had outgrown its relational store.',
    problem:
      'Search and aggregation performance was bounded by the relational database, and scaling the database further was not the answer.',
    constraint: 'A live commerce system with existing data and existing query semantics to preserve.',
    decisions: [
      'Lead a migration of the search path to Elasticsearch rather than continuing to tune the relational queries.',
      'Own the aggregation and search performance work end to end, not just the data move.',
    ],
    outcome:
      'Search and aggregation performance optimized and the scalability ceiling of the e-commerce system raised.',
    stack: ['Java', 'Spring Boot', 'Elasticsearch', 'MariaDB', 'PostgreSQL'],
  },
];

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">
        {heading}
      </h4>
      <div className="mt-1 text-xs leading-relaxed text-slate-300">{children}</div>
    </div>
  );
}

export default function CaseStudyCard() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <HighlightCard
        icon={<span aria-hidden="true">🛠️</span>}
        title="Ownership — Case Studies"
        subtitle={`${STUDIES.length} decisions, in full`}
        badge="Depth"
        description="Problem, constraint, the call he made, and what happened — on a live wealth platform and an e-commerce search migration."
        onClick={() => setOpen(true)}
      />
      <DetailsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Ownership — Case Studies"
        description="Architectural calls Davit made, with the constraints he made them under."
      >
        <div className="space-y-6">
          {STUDIES.map((study) => (
            <article
              key={study.id}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
            >
              <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">
                {study.label}
              </p>
              <h3 className="mt-1 text-sm font-semibold text-white">{study.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{study.context}</p>

              <div className="mt-4 space-y-3">
                <Section heading="Problem">{study.problem}</Section>
                <Section heading="Constraint">{study.constraint}</Section>
                <Section heading="Decisions">
                  <ul className="ml-4 list-disc space-y-1 marker:text-slate-600">
                    {study.decisions.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </Section>
                <Section heading="Outcome">{study.outcome}</Section>
              </div>

              <ul className="mt-4 flex flex-wrap gap-1.5 border-t border-white/10 pt-3">
                {study.stack.map((t) => (
                  <li
                    key={t}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-slate-300"
                  >
                    {t}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </DetailsDialog>
    </>
  );
}
