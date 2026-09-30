import { Link } from "react-router";
import { EmptyState, buttonClass } from "@web/components/ui";

export function NotFoundPage({ embedded = false }: { embedded?: boolean }) {
  const Tag = embedded ? "div" : "main";
  return (
    <Tag id={embedded ? undefined : "main"} className="mx-auto max-w-xl px-4 py-12">
      <EmptyState title="Page not found" action={<Link to="/projects" className={buttonClass("secondary")}>Go to projects</Link>}>
        The page you asked for does not exist.
      </EmptyState>
    </Tag>
  );
}
