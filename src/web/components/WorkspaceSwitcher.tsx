/** Workspace switcher (select). OWNED BY: web-shell. */
import { useId } from "react";
import { useNavigate } from "react-router";
import { useSession } from "@web/lib/session";
import { cx, inputClass } from "./ui";

export function WorkspaceSwitcher({ className }: { className?: string }) {
  const { me, workspaceId, setWorkspaceId } = useSession();
  const navigate = useNavigate();
  const id = useId();
  if (!me || me.workspaces.length === 0) return null;
  if (me.workspaces.length === 1) {
    return <span className={cx("truncate text-sm text-zinc-600 dark:text-zinc-400", className)}>{me.workspaces[0]!.name}</span>;
  }
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <label htmlFor={id} className="sr-only">
        Workspace
      </label>
      <select
        id={id}
        className={cx(inputClass, "w-auto max-w-56 py-1")}
        value={workspaceId ?? ""}
        onChange={(e) => {
          setWorkspaceId(e.target.value);
          navigate("/projects");
        }}
      >
        {me.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
            {w.role === "owner" ? " (owner)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
