import { Fragment, type ReactNode } from 'react';

/**
 * Minimal markdown renderer for assistant answers.
 *
 * The system prompt in `api/ask/route.ts` asks the model for "short structured
 * sections", so answers routinely come back with `###` headings, `**bold**`
 * labels and `-` lists. Rendering them through `whitespace-pre-wrap` showed the
 * raw syntax to the visitor.
 *
 * Deliberately hand-rolled and deliberately small: it covers exactly the subset
 * the prompt produces, adds no dependency, and never touches
 * `dangerouslySetInnerHTML` — every node below is a real React element, so
 * model output can't inject markup.
 */

/** Splits a line into bold / italic / code / link spans. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // One pass, alternating between matches and the literal text between them.
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={key} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-slate-900/80 px-1.5 py-0.5 font-mono text-[0.85em] text-violet-200"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (linkMatch) {
        const href = linkMatch[2];
        const safe = /^(https?:|mailto:)/i.test(href);
        nodes.push(
          safe ? (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-violet-300 underline underline-offset-2 hover:text-violet-200"
            >
              {linkMatch[1]}
            </a>
          ) : (
            <Fragment key={key}>{linkMatch[1]}</Fragment>
          ),
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

type Block =
  | { kind: 'heading'; level: 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

/**
 * Groups lines into blocks. Consecutive non-empty, non-special lines join into
 * one paragraph so that a model's soft-wrapped prose doesn't render as a stack
 * of one-line paragraphs.
 */
function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      // Answers live inside an <h2>-titled panel, so clamp to h3/h4 to keep the
      // document outline sane no matter what level the model emits.
      const level = heading[1].length <= 2 ? 3 : 4;
      blocks.push({ kind: 'heading', level: level as 3 | 4, text: heading[2] });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }

    // A plain line directly under a list item is a continuation of it.
    if (list) {
      list.items[list.items.length - 1] += ` ${line}`;
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

export default function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);

  return (
    <div className="space-y-2.5 break-words text-sm leading-relaxed">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          const Tag = block.level === 3 ? 'h3' : 'h4';
          return (
            <Tag
              key={i}
              className="pt-1 text-[13px] font-semibold uppercase tracking-wide text-violet-300"
            >
              {renderInline(block.text, `h${i}`)}
            </Tag>
          );
        }

        if (block.kind === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag
              key={i}
              className={`ml-4 space-y-1 ${block.ordered ? 'list-decimal' : 'list-disc'} marker:text-slate-500`}
            >
              {block.items.map((item, j) => (
                <li key={j} className="pl-1">
                  {renderInline(item, `l${i}-${j}`)}
                </li>
              ))}
            </ListTag>
          );
        }

        return <p key={i}>{renderInline(block.text, `p${i}`)}</p>;
      })}
    </div>
  );
}
