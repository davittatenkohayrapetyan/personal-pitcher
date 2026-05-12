import BackgroundPhotos from './BackgroundPhotos';

const HERO_PHOTOS = [
  { src: '/photos/hiking.svg',      alt: 'Hiking in Armenian mountains' },
  { src: '/photos/chess.svg',       alt: 'Chess player rated ~1800' },
  { src: '/photos/coding.svg',      alt: 'Late-night coding sessions' },
  { src: '/photos/speaking.svg',    alt: 'Speaking at ArmeniaJS 2023' },
  { src: '/photos/photography.svg', alt: 'Photography with Sony Alpha' },
  { src: '/photos/coffee.svg',      alt: 'Specialty coffee roasting' },
  { src: '/photos/reading.svg',     alt: 'Reading ~30 books per year' },
];

const STATS = [
  { value: '6+',    label: 'Years Experience' },
  { value: '500k+', label: 'Daily Active Users' },
  { value: '500+',  label: 'GitHub Stars' },
  { value: '30+',   label: 'ADPList Sessions' },
];

const SKILLS = ['TypeScript', 'Go', 'React', 'Next.js', 'Kubernetes', 'AI/ML', 'gRPC', 'RAG'];

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Scattered background photos */}
      <BackgroundPhotos photos={HERO_PHOTOS} />

      {/* Animated gradient blobs */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute top-20 left-20 w-64 h-64 bg-blue-500 rounded-full filter blur-3xl animate-pulse" />
        <div className="absolute bottom-20 right-20 w-96 h-96 bg-purple-500 rounded-full filter blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-indigo-500 rounded-full filter blur-3xl animate-pulse" style={{ animationDelay: '0.5s' }} />
      </div>

      <div className="relative z-10 text-center px-6 sm:px-8 max-w-4xl mx-auto py-20">
        {/* Avatar */}
        <div className="mx-auto mb-6 w-28 h-28 sm:w-32 sm:h-32 rounded-full bg-gradient-to-br from-blue-400 to-purple-600 flex items-center justify-center shadow-2xl ring-4 ring-white/20">
          <span className="text-4xl sm:text-5xl font-bold text-white">DH</span>
        </div>

        <h1 className="text-4xl sm:text-5xl md:text-7xl font-bold text-white mb-3 tracking-tight">
          Davit Hayrapetyan
        </h1>
        <p className="text-lg sm:text-xl md:text-2xl text-blue-300 mb-4 font-medium">
          Senior Software Engineer &amp; Open Source Builder
        </p>
        <p className="text-base sm:text-lg text-slate-300 mb-8 max-w-2xl mx-auto leading-relaxed px-2">
          Building scalable distributed systems, AI-powered products, and developer tooling.
          Open source maintainer and community contributor based in Yerevan, Armenia.
        </p>

        {/* Skill tags */}
        <div className="flex flex-wrap gap-2 sm:gap-3 justify-center mb-10 px-2">
          {SKILLS.map((skill) => (
            <span
              key={skill}
              className="px-3 sm:px-4 py-1.5 sm:py-2 bg-white/10 backdrop-blur-sm text-white rounded-full text-xs sm:text-sm font-medium border border-white/20 hover:bg-white/20 transition-colors"
            >
              {skill}
            </span>
          ))}
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 mb-10 max-w-2xl mx-auto">
          {STATS.map((stat) => (
            <div key={stat.label} className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl px-3 py-4">
              <p className="text-2xl sm:text-3xl font-bold text-white">{stat.value}</p>
              <p className="text-xs text-slate-400 mt-1 leading-tight">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* CTA buttons */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
          <a
            href="#ask"
            className="inline-flex items-center gap-2 px-7 py-3.5 sm:px-8 sm:py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-full transition-all shadow-lg hover:shadow-blue-500/30 hover:shadow-xl text-sm sm:text-base w-full sm:w-auto justify-center"
          >
            <span>Ask me anything</span>
            <svg className="w-4 h-4 sm:w-5 sm:h-5 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </a>
          <a
            href="https://github.com/davittatenkohayrapetyan"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-7 py-3.5 sm:px-8 sm:py-4 bg-white/10 hover:bg-white/20 border border-white/20 text-white font-semibold rounded-full transition-all text-sm sm:text-base w-full sm:w-auto justify-center"
          >
            <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/>
            </svg>
            <span>GitHub</span>
          </a>
        </div>
      </div>
    </section>
  );
}
