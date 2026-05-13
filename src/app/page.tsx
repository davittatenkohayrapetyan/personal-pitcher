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
        Dashboard layout:
          - Mobile (default): single column, assistant placed near the top via `order-*`.
          - Desktop (lg+): two columns — profile/details on the left, sticky assistant on the right.
      */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-8">
        {/* LEFT COLUMN — profile, stats, highlight cards */}
        <div className="order-2 flex flex-col gap-6 lg:order-1 lg:col-span-7">
          <ProfileHero />
          <StatsGrid />

          <section aria-labelledby="highlights-heading">
            <h2
              id="highlights-heading"
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400"
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
              Tap any card for full details, or just ask the assistant.
            </p>
          </section>
        </div>

        {/* RIGHT COLUMN — AI assistant (primary CTA) */}
        <aside
          className="order-1 lg:sticky lg:top-20 lg:order-2 lg:col-span-5 lg:self-start"
          aria-label="AI assistant"
        >
          <AssistantPanel />
        </aside>
      </div>
    </AppShell>
  );
}
