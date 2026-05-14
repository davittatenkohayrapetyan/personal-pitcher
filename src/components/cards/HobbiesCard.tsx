'use client';

import { useState } from 'react';
import hobbiesData from '../../../data/hobbies.json';
import HighlightCard from '../HighlightCard';
import DetailsDialog from '../DetailsDialog';

export default function HobbiesCard() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <HighlightCard
        icon={<span aria-hidden="true">🎹</span>}
        title="Hobbies & Interests"
        subtitle={`${hobbiesData.hobbies.length} pursuits · ${hobbiesData.languages.length} languages`}
        description="Music production as 'Shepard D', fitness, mentoring, AI tinkering, travel."
        onClick={() => setOpen(true)}
      />
      <DetailsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Hobbies & Interests"
        description="A glimpse into Davit's world beyond the code editor."
      >
        <div className="space-y-6">
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {hobbiesData.hobbies.map((hobby) => (
              <li
                key={hobby.name}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span aria-hidden="true" className="text-2xl">{hobby.icon}</span>
                  <h3 className="text-sm font-semibold text-white">{hobby.name}</h3>
                </div>
                <p className="text-xs leading-relaxed text-slate-400">{hobby.description}</p>
              </li>
            ))}
          </ul>

          <section aria-labelledby="languages-heading">
            <h3 id="languages-heading" className="mb-3 text-sm font-semibold text-white">
              Languages spoken
            </h3>
            <ul className="flex flex-wrap gap-2">
              {hobbiesData.languages.map((lang) => (
                <li
                  key={lang.name}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs"
                >
                  <span className="font-medium text-white">{lang.name}</span>
                  <span className="ml-1.5 text-slate-400">· {lang.level}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DetailsDialog>
    </>
  );
}
