/** Raw provider answer as plain preformatted text; brand spans highlighted via string splitting only. */
import { useMemo } from "react";
import { segmentText, type SpanInput } from "../lib";

export function HighlightedAnswer({ text, brands }: { text: string; brands: SpanInput[] }) {
  const segments = useMemo(() => segmentText(text, brands), [text, brands]);
  return (
    <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-3 font-sans text-sm leading-relaxed text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
      {segments.map((s, i) =>
        s.brandKey ? (
          <mark
            key={i}
            title={s.brandKey}
            className={
              s.isSelf
                ? "rounded-sm bg-indigo-200 px-0.5 text-indigo-950 dark:bg-indigo-800 dark:text-indigo-50"
                : "rounded-sm bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-800 dark:text-amber-50"
            }
          >
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </pre>
  );
}
