import communityData from '../../data/community.json';

export default function CommunitySection() {
  return (
    <section className="py-16 sm:py-20 bg-slate-800 relative overflow-hidden">
      {/* Subtle glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-10 right-10 w-72 h-72 bg-purple-600/5 rounded-full filter blur-3xl" />
      </div>

      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10 sm:mb-14">
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-white mb-3">
            Community &amp; Impact
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto text-sm sm:text-base">
            Giving back through talks, mentoring, open source, and writing.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
          {/* Talks */}
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-400 text-lg">
                🎤
              </div>
              <h3 className="text-white font-bold text-base">Talks</h3>
            </div>
            <ul className="space-y-4">
              {communityData.talks.map((talk) => (
                <li key={talk.title}>
                  <p className="text-slate-200 text-sm font-medium leading-tight mb-0.5">{talk.title}</p>
                  <p className="text-slate-500 text-xs">{talk.event} · {talk.year}</p>
                </li>
              ))}
            </ul>
          </div>

          {/* Mentoring */}
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl bg-green-500/20 flex items-center justify-center text-green-400 text-lg">
                🤝
              </div>
              <h3 className="text-white font-bold text-base">Mentoring</h3>
            </div>
            <ul className="space-y-3">
              {communityData.mentoring.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0 mt-1.5" />
                  <p className="text-slate-400 text-sm leading-snug">{item}</p>
                </li>
              ))}
            </ul>
          </div>

          {/* Open Source */}
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400 text-lg">
                ⭐
              </div>
              <h3 className="text-white font-bold text-base">Open Source</h3>
            </div>
            <ul className="space-y-3">
              {communityData.openSource.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0 mt-1.5" />
                  <p className="text-slate-400 text-sm leading-snug">{item}</p>
                </li>
              ))}
            </ul>
          </div>

          {/* Writing */}
          <div className="bg-slate-900/60 border border-slate-700 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl bg-rose-500/20 flex items-center justify-center text-rose-400 text-lg">
                ✍️
              </div>
              <h3 className="text-white font-bold text-base">Writing</h3>
            </div>
            <ul className="space-y-4">
              {communityData.writing.map((article) => (
                <li key={article.title}>
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-200 text-sm font-medium hover:text-blue-300 transition-colors leading-tight block mb-0.5"
                  >
                    {article.title}
                  </a>
                  <p className="text-slate-500 text-xs">{article.platform} · {article.year}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
