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
          className="rounded-full border border-slate-400/15 bg-slate-800/70 px-3 py-1.5 text-xs font-medium text-slate-200 transition-all hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {q}
        </button>
      ))}
    </div>
  );
}
