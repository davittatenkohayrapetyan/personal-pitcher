import hobbiesData from '../../data/hobbies.json';

const HOBBY_COLORS: Record<string, string> = {
  Chess:        'from-amber-400 to-orange-600',
  Hiking:       'from-emerald-400 to-teal-600',
  Photography:  'from-rose-400 to-red-600',
  Reading:      'from-violet-400 to-purple-600',
  Coffee:       'from-yellow-400 to-amber-600',
};

const HOBBY_ROTATIONS = ['-rotate-3', 'rotate-2', '-rotate-1', 'rotate-3', '-rotate-2'];

export default function PhotoCards() {
  return (
    <section className="py-16 sm:py-20 bg-slate-800 overflow-hidden">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="text-2xl sm:text-3xl font-bold text-white text-center mb-3">Moments &amp; Interests</h2>
        <p className="text-slate-400 text-center mb-10 sm:mb-12 max-w-xl mx-auto text-sm sm:text-base">
          A glimpse into Davit&apos;s world beyond the code editor.
        </p>

        {/* Hobby cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4 mb-12 sm:mb-16">
          {hobbiesData.hobbies.map((hobby, i) => {
            const color = HOBBY_COLORS[hobby.name] ?? 'from-blue-400 to-indigo-600';
            const rotation = HOBBY_ROTATIONS[i % HOBBY_ROTATIONS.length];
            return (
              <div
                key={hobby.name}
                className={`group relative bg-gradient-to-br ${color} rounded-2xl p-[3px] shadow-xl cursor-default transform ${rotation} hover:rotate-0 hover:scale-105 transition-all duration-300`}
              >
                <div className="bg-slate-900/40 backdrop-blur-sm rounded-xl p-4 h-full flex flex-col items-center justify-center gap-2 min-h-[120px] sm:min-h-[130px]">
                  <span className="text-3xl sm:text-4xl">{hobby.icon}</span>
                  <p className="text-white text-xs text-center font-semibold leading-tight opacity-90 group-hover:opacity-100">
                    {hobby.name}
                  </p>
                  <p className="text-white/60 text-[10px] text-center leading-tight hidden sm:block group-hover:text-white/80 transition-colors line-clamp-2">
                    {hobby.description.split('.')[0]}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Languages spoken */}
        <div className="border-t border-slate-700 pt-10 sm:pt-12">
          <h3 className="text-lg sm:text-xl font-semibold text-white text-center mb-6">Languages Spoken</h3>
          <div className="flex flex-wrap justify-center gap-3 sm:gap-4">
            {hobbiesData.languages.map((lang) => (
              <div
                key={lang.name}
                className="flex items-center gap-2 sm:gap-3 bg-slate-700/50 border border-slate-600 rounded-xl px-4 py-3 min-w-[140px] justify-center"
              >
                <div className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                <div>
                  <p className="text-white text-sm font-semibold">{lang.name}</p>
                  <p className="text-slate-400 text-xs">{lang.level}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
