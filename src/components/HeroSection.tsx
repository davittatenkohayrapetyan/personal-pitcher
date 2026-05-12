export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Animated background dots */}
      <div className="absolute inset-0 opacity-20">
        <div className="absolute top-20 left-20 w-64 h-64 bg-blue-500 rounded-full filter blur-3xl animate-pulse" />
        <div className="absolute bottom-20 right-20 w-96 h-96 bg-purple-500 rounded-full filter blur-3xl animate-pulse delay-1000" />
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-indigo-500 rounded-full filter blur-3xl animate-pulse delay-500" />
      </div>

      <div className="relative z-10 text-center px-4 max-w-4xl mx-auto">
        {/* Avatar placeholder */}
        <div className="mx-auto mb-8 w-32 h-32 rounded-full bg-gradient-to-br from-blue-400 to-purple-600 flex items-center justify-center shadow-2xl ring-4 ring-white/20">
          <span className="text-5xl font-bold text-white">DH</span>
        </div>

        <h1 className="text-5xl md:text-7xl font-bold text-white mb-4 tracking-tight">
          Davit Hayrapetyan
        </h1>
        <p className="text-xl md:text-2xl text-blue-300 mb-4 font-medium">
          Senior Software Engineer &amp; Open Source Enthusiast
        </p>
        <p className="text-lg text-slate-300 mb-8 max-w-2xl mx-auto leading-relaxed">
          Building scalable systems, contributing to open source, and mentoring the next generation of developers in Yerevan, Armenia.
        </p>

        <div className="flex flex-wrap gap-3 justify-center mb-10">
          {['TypeScript', 'Go', 'React', 'Kubernetes', 'AI/ML'].map((skill) => (
            <span
              key={skill}
              className="px-4 py-2 bg-white/10 backdrop-blur-sm text-white rounded-full text-sm font-medium border border-white/20 hover:bg-white/20 transition-colors"
            >
              {skill}
            </span>
          ))}
        </div>

        <a
          href="#ask"
          className="inline-flex items-center gap-2 px-8 py-4 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-full transition-all shadow-lg hover:shadow-blue-500/30 hover:shadow-xl"
        >
          <span>Ask me anything</span>
          <svg className="w-5 h-5 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </a>
      </div>
    </section>
  );
}
