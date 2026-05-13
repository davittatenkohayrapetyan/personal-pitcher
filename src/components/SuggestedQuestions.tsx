'use client';

interface SuggestedQuestionsProps {
  questions: readonly string[];
  onSelect: (q: string) => void;
  disabled?: boolean;
}

export default function SuggestedQuestions({
  questions,
  onSelect,
  disabled,
}: SuggestedQuestionsProps) {
  return (
    <div
      role="group"
      aria-label="Suggested questions"
      className="flex flex-wrap gap-2"
    >
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => onSelect(q)}
          disabled={disabled}
          className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-300 transition-all hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {q}
        </button>
      ))}
    </div>
  );
}
