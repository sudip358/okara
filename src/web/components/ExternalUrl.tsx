/**
 * A URL from provider or crawl data. It becomes a link (new tab, rel="noopener noreferrer nofollow") only when
 * it parses as http(s); anything else (javascript:, data:, garbage) renders as plain text.
 */
import type { ReactNode } from "react";
import { safeHref } from "@web/pages/links/lib";

export function ExternalUrl({ url, className, children }: { url: string; className?: string; children?: ReactNode }) {
  const href = safeHref(url);
  if (!href) return <span className={`${className ?? ""} break-all text-xs text-zinc-700 dark:text-zinc-300`}>{url}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={`${className ?? ""} break-all rounded text-xs text-sky-700 underline hover:text-sky-900 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-400`}
    >
      {url}
      {children}
    </a>
  );
}
