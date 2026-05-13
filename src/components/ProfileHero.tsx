import Image from 'next/image';

const BADGES = [
  { icon: '⚙️', label: 'Java · Kotlin · Spring Boot' },
  { icon: '🌐', label: 'Distributed Systems' },
  { icon: '☁️', label: 'Cloud · DevOps' },
  { icon: '🎤', label: 'GDG Yerevan Organizer' },
  { icon: '🎓', label: 'University Lecturer' },
  { icon: '🎹', label: 'Music Producer' },
];

/**
 * Identity card: profile photo, name, role, one-line pitch, skill badges,
 * and social links.  No decorative background images — keeps layout clean.
 */
export default function ProfileHero() {
  return (
    <section
      aria-labelledby="profile-heading"
      className="rounded-2xl border border-slate-400/15 bg-slate-900/80 p-5 shadow-xl shadow-black/20 sm:p-6"
    >
      {/* Avatar row */}
      <div className="flex items-start gap-4 sm:gap-5">
        {/* Profile photo */}
        <div className="relative h-20 w-20 flex-shrink-0 overflow-hidden rounded-2xl ring-2 ring-violet-400/20 shadow-lg sm:h-24 sm:w-24">
          <Image
            src="/photos/1766579457955.jpg"
            alt="Davit Hayrapetyan"
            fill
            className="object-cover object-center"
            priority
          />
        </div>

        {/* Name + title + pitch */}
        <div className="min-w-0 flex-1">
          <h1
            id="profile-heading"
            className="text-xl font-bold leading-tight tracking-tight text-white sm:text-2xl lg:text-3xl"
          >
            Davit Hayrapetyan
          </h1>
          <p className="mt-0.5 text-sm font-medium text-violet-300 sm:text-base">
            Staff Software Engineer · Backend Architect
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-300 sm:text-sm">
            13+ years delivering resilient distributed systems. GDG Yerevan organizer,
            university lecturer, and electronic music producer.
          </p>
        </div>
      </div>

      {/* Skill badges */}
      <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Key areas of expertise">
        {BADGES.map((b) => (
          <li
            key={b.label}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-400/15 bg-slate-800/60 px-2.5 py-1 text-xs text-slate-200"
          >
            <span aria-hidden="true">{b.icon}</span>
            {b.label}
          </li>
        ))}
      </ul>

      {/* Social links */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-400/10 pt-4">
        <a
          href="https://github.com/davittatenkohayrapetyan"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-400/15 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-violet-400/40 hover:text-white"
          aria-label="Davit Hayrapetyan on GitHub (opens in new tab)"
        >
          <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12" />
          </svg>
          GitHub
        </a>
        <a
          href="https://www.linkedin.com/in/davit-hayrapetyan-04377561"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-400/15 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-sky-400/40 hover:text-white"
          aria-label="Davit Hayrapetyan on LinkedIn (opens in new tab)"
        >
          <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
          </svg>
          LinkedIn
        </a>
        <span className="ml-auto text-[11px] text-slate-500">
          📍 Yerevan, Armenia
        </span>
      </div>
    </section>
  );
}
