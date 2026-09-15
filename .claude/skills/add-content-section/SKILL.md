---
name: add-content-section
description: Add or extend a profile content section (a new topic the assistant can answer about, like "music" or "speaking"). Use when adding a new data file under data/, adding a new Intent, or wiring a new explore card. Covers the full chain from data file to card, including the spots the type checker will not catch for you.
---

# Adding a profile content section

A "section" is one topic the assistant can answer about. Adding one touches ~8 files in a fixed order. The `music` section (commit `e63dfc0`) is the reference implementation — read those files if anything here is ambiguous.

Use `<section>` for the lowercase intent name (e.g. `music`) and `<Section>` for the component name (e.g. `Music`).

## 1. Data — `data/<section>.json`

Top-level key matching the section name, since the loader does `raw.<section> ?? raw`:

```json
{ "<section>": { ... } }
```

Nullable fields are fine (`data/music.json` has `"spotifyId": null`); the loader and card both guard for them.

## 2. Type — `src/types/index.ts`

Add a field to `ProfileContext`. **Type-enforced** — the loader will not compile until it returns this field.

## 3. Loader — `src/lib/profile/loader.ts`

`readDataFile('<section>.json')`, then format into a **plain string**. This is not vector search — the string is pasted straight into the prompt, so write it the way you want the model to read it. Guard every optional field (`Array.isArray(x) && x.length ? ... : ''`), then `.filter(Boolean).join('\n\n')`.

## 4. Retrieval — `src/lib/retrieval.ts`

**Two edits, only one of which is obvious:**
- Add `case '<section>':` returning `${ctx.bio}\n\n## <Section>\n${ctx.<section>}`.
- Add the section to the `case 'general':` concatenation. Miss this and the section is invisible to "tell me about Davit" questions — silently, with no error.

## 5. Classification — `src/lib/classify.ts`

**Five edits. Only the second is type-enforced.** Missing any of the others fails silently:

| Edit | What breaks if missed |
|---|---|
| `Intent` union | — (compile error, safe) |
| `INTENT_PATTERNS` | — (compile error: `Record<Intent, RegExp[]>` is exhaustive) |
| `VALID_INTENTS` set | The LLM returns the right intent, `parseIntent` rejects it, request silently degrades to the regex tier |
| `DAVIT_KEYWORDS` | Regex tier classifies the question `off_topic` and the route short-circuits with the "I can only answer about Davit" canned reply |
| `INTENT_CLASSIFICATION_PROMPT` | The LLM never emits the intent at all, because it was never told the intent exists |

## 6. Card — `src/components/cards/<Section>Card.tsx`

Follow `MusicCard.tsx`. Conventions in this repo:
- `'use client'` at the top; cards own their open/closed dialog state.
- Import data with a **relative** path — `import data from '../../../data/<section>.json'`. The `@/*` alias maps to `./src/*` only, so it cannot reach `data/`.
- Compose `HighlightCard` (collapsed) + `DetailsDialog` (expanded).

## 7. Page — `src/app/page.tsx`

Add the card to the explore grid. Order is visual priority; the grid is 1-col mobile, 2-col at `sm`.

## 8. Optional but usually wanted

- `src/components/AssistantPanel.tsx` — add a suggested question so the section is discoverable.
- `data/profile.md` — mirror the content into the bio markdown. `profile.md` is returned as `ctx.bio` for **every** intent, so anything there is always in context; the section file is only loaded for its own intent and `general`.

## Verify

Run the `verify` skill. At minimum: `npx tsc --noEmit`, then ask the assistant a question that should hit the new intent and confirm `intent:<section>` appears in `workflowSteps` in `logs/app-<date>.log`.
