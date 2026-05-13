'use client';

import { useState } from 'react';
import HighlightCard from '../HighlightCard';
import DetailsDialog from '../DetailsDialog';

const SKILL_GROUPS: { name: string; items: string[] }[] = [
  {
    name: 'Backend Engineering',
    items: ['Java', 'Kotlin', 'Spring Boot', 'Java EE', 'Hibernate', 'Quarkus', 'REST APIs', 'Distributed Systems', 'Microservices'],
  },
  {
    name: 'Cloud & DevOps',
    items: ['AWS', 'Azure', 'Docker', 'Docker Swarm', 'CI/CD', 'Jenkins', 'OpenTelemetry', 'Splunk'],
  },
  {
    name: 'Databases & Messaging',
    items: ['OracleDB', 'PostgreSQL', 'MongoDB', 'Redis', 'Elasticsearch', 'Kafka', 'IBM MQ'],
  },
  {
    name: 'Frontend',
    items: ['Angular', 'TypeScript', 'React'],
  },
  {
    name: 'Leadership & Communication',
    items: [
      'System Design',
      'Technical Leadership',
      'Mentorship',
      'Architecture Discussions',
      'Stakeholder Communication',
      'Developer Community Organization',
    ],
  },
  {
    name: 'AI & Emerging Tech',
    items: ['AI Agents', 'RAG Systems', 'AI-assisted Developer Tooling', 'Local LLM experimentation', 'Intelligent Automation'],
  },
];

const TOTAL = SKILL_GROUPS.reduce((acc, g) => acc + g.items.length, 0);

export default function SkillsCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HighlightCard
        icon={<span aria-hidden="true">⚙️</span>}
        title="Skills & Stack"
        subtitle={`${TOTAL}+ technologies across ${SKILL_GROUPS.length} areas`}
        description="Java, Kotlin, Spring Boot, distributed systems, cloud-native, and AI tooling."
        onClick={() => setOpen(true)}
      />
      <DetailsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Skills & Stack"
        description="A grouped view of Davit's technical and leadership skills."
      >
        <div className="space-y-5">
          {SKILL_GROUPS.map((group) => (
            <section key={group.name} aria-labelledby={`skills-${group.name}`}>
              <h3
                id={`skills-${group.name}`}
                className="mb-2 text-xs font-semibold uppercase tracking-wide text-violet-300"
              >
                {group.name}
              </h3>
              <ul className="flex flex-wrap gap-1.5">
                {group.items.map((s) => (
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
