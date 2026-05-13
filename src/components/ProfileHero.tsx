import Image from 'next/image';

const PHOTOS = [
  { src: '/photos/devfest.jpg', alt: 'Davit organizing DevFest Armenia' },
  { src: '/photos/speaker.jpg', alt: 'Davit speaking at a community event' },
  { src: '/photos/firecode.jpg', alt: 'Davit mentoring at FireCode hackathon' },
];

/**
 * Identity card: avatar, name, role, short pitch, contact links.
 * Decorative photos are bounded inside this card via overflow-hidden.
 */
export default function ProfileHero() {
  return (
    <section
      aria-labelledby="profile-heading"
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950 p-5 shadow-xl shadow-black/30 sm:p-6"
    >
      {/* Bounded decorative photo strip — only visible on wider screens, sits behind content */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 hidden opacity-[0.08] lg:block"
      >
        <div className="absolute -right-6 top-4 rotate-6">
          <Image
            src={PHOTOS[0].src}
            alt=""
            width={140}
            height={180}
            className="rounded-md object-cover"
          />
        </div>
        <div className="absolute -right-2 bottom-6 -rotate-3">
          <Image
            src={PHOTOS[1].src}
            alt=""
            width={120}
            height={150}
            className="rounded-md object-cover"
          />
        </div>
        <div className="absolute right-32 -top-2 -rotate-6">
          <Image
            src={PHOTOS[2].src}
            alt=""
            width={110}
            height={140}
            className="rounded-md object-cover"
          />
        </div>
      </div>

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
        <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-2xl ring-2 ring-white/10 shadow-lg shadow-violet-900/40 sm:h-20 sm:w-20">
          <Image
            src="/photos/1766579457955.jpg"
            alt="Davit Hayrapetyan"
            fill
            className="object-cover"
          />
        </div>
        <div className="min-w-0 flex-1">
          <h1
            id="profile-heading"
            className="text-2xl font-bold tracking-tight text-white sm:text-3xl"
          >
            Davit Hayrapetyan
          </h1>
          <p className="mt-1 text-sm font-medium text-violet-300 sm:text-base">
            Staff Software Engineer · Backend Architect
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">
            13+ years building distributed systems, microservices, and resilient backend platforms.
            GDG Yerevan organizer, university lecturer, and electronic music producer based in
            Yerevan, Armenia.
          </p>
          <ul className="mt-4 flex flex-wrap gap-2 text-xs text-slate-300">
            <li className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
              <span aria-hidden="true">📍</span> Yerevan, Armenia
            </li>
            <li className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
              <span aria-hidden="true">🎤</span> GDG Organizer since 2022
            </li>
            <li className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
              <span aria-hidden="true">🎓</span> University Lecturer
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
