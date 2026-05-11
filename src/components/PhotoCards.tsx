const cards = [
  { emoji: '🏔', label: 'Hiking in Armenian mountains', color: 'from-emerald-400 to-teal-600', rotation: '-rotate-3', x: 'translate-x-0', delay: '' },
  { emoji: '♟', label: 'Chess tournament champion', color: 'from-amber-400 to-orange-600', rotation: 'rotate-2', x: 'translate-x-0', delay: 'delay-75' },
  { emoji: '💻', label: 'Late-night coding sessions', color: 'from-blue-400 to-indigo-600', rotation: '-rotate-1', x: 'translate-x-0', delay: 'delay-150' },
  { emoji: '🎤', label: 'Speaking at ArmeniaJS', color: 'from-purple-400 to-pink-600', rotation: 'rotate-3', x: 'translate-x-0', delay: 'delay-200' },
  { emoji: '📷', label: 'Photography adventures', color: 'from-rose-400 to-red-600', rotation: '-rotate-2', x: 'translate-x-0', delay: 'delay-300' },
  { emoji: '☕', label: 'Specialty coffee roasting', color: 'from-yellow-400 to-amber-600', rotation: 'rotate-1', x: 'translate-x-0', delay: 'delay-75' },
];

export default function PhotoCards() {
  return (
    <section className="py-20 bg-slate-800 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4">
        <h2 className="text-3xl font-bold text-white text-center mb-4">Moments &amp; Interests</h2>
        <p className="text-slate-400 text-center mb-12 max-w-xl mx-auto">
          A glimpse into Davit&apos;s world beyond the code editor.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {cards.map((card, i) => (
            <div
              key={i}
              className={`group relative bg-gradient-to-br ${card.color} rounded-2xl p-1 shadow-xl cursor-pointer transform ${card.rotation} hover:rotate-0 hover:scale-110 transition-all duration-300 ${card.delay}`}
            >
              <div className="bg-slate-900/30 backdrop-blur-sm rounded-xl p-4 h-full flex flex-col items-center justify-center gap-2 min-h-[120px]">
                <span className="text-4xl">{card.emoji}</span>
                <p className="text-white text-xs text-center font-medium leading-tight opacity-80 group-hover:opacity-100">
                  {card.label}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
