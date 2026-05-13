import AppShell from '@/components/AppShell';
import ProfileHero from '@/components/ProfileHero';
import StatsGrid from '@/components/StatsGrid';
import AssistantPanel from '@/components/AssistantPanel';
import ProjectsCard from '@/components/cards/ProjectsCard';
import CommunityImpactCard from '@/components/cards/CommunityImpactCard';
import HobbiesCard from '@/components/cards/HobbiesCard';
import SkillsCard from '@/components/cards/SkillsCard';
import ExperienceCard from '@/components/cards/ExperienceCard';

export default function Home() {
  return (
    <AppShell>
      {/*
        Responsive layout:
          Mobile / tablet  — flex-col with `order-*`:
            1. ProfileHero + StatsGrid
            2. AssistantPanel  ← primary CTA near the top
            3. Explore cards

          Desktop (lg+) — two-column grid:
            Left  (flex): ProfileHero + StatsGrid + Explore cards
            Right (sticky): AssistantPanel
      */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)] lg:items-start lg:gap-8">

        {/* ── GROUP 1: Identity ── order-1 on mobile; left-col row-1 on desktop */}
        <div className="order-1 flex flex-col gap-5 lg:col-start-1 lg:row-start-1">
          <ProfileHero />
          <StatsGrid />
        </div>

        {/* ── GROUP 2: AI Assistant ── order-2 on mobile; right-col spanning both rows on desktop */}
        <aside
          className="order-2 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start lg:sticky lg:top-20"
          aria-label="AI assistant"
        >
          <AssistantPanel />
        </aside>

        {/* ── GROUP 3: Explore cards ── order-3 on mobile; left-col row-2 on desktop */}
        <section
          className="order-3 lg:col-start-1 lg:row-start-2"
          aria-labelledby="explore-heading"
        >
          <h2
            id="explore-heading"
            className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400"
          >
            Explore
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ExperienceCard />
            <SkillsCard />
            <ProjectsCard />
            <CommunityImpactCard />
            <HobbiesCard />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Tap any card to see full details, or ask the assistant on the right.
          </p>
        </section>

      </div>
    </AppShell>
  );
}
