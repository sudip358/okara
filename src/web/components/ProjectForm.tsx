/** ProjectInput form shared by onboarding and settings. OWNED BY: web-shell. */
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { Competitor, ProjectInput, SiteType } from "@shared/types";
import { LIMITS, MAX_COMPETITORS, domainError, normalizeDomain, validateProjectInput } from "@web/lib/validation";
import { ChipInput } from "./ChipInput";
import { Button, Card, SelectField, StateBanner, TextArea, TextField } from "./ui";

export const SITE_TYPES: Array<{ value: SiteType; label: string }> = [
  { value: "ecommerce", label: "E-commerce" },
  { value: "saas", label: "SaaS" },
  { value: "publisher", label: "Publisher" },
  { value: "local", label: "Local business" },
  { value: "other", label: "Other" },
];

export const emptyProjectInput = (): ProjectInput => ({
  name: "",
  siteUrl: "https://",
  siteType: "ecommerce",
  brandName: "",
  brandAliases: [],
  competitors: [],
  productDescription: "",
  audience: "",
  locale: "en-US",
  language: "en",
  voice: "",
});

export function ProjectForm({
  initial,
  submitLabel,
  onSubmit,
  submitting,
  serverError,
}: {
  initial: ProjectInput;
  submitLabel: string;
  onSubmit: (input: ProjectInput) => void;
  submitting: boolean;
  serverError?: ReactNode;
}) {
  const [v, setV] = useState<ProjectInput>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const idp = useId();
  const { errors, warnings } = validateProjectInput(v);
  const err = (k: string) => (showErrors ? (errors[k] ?? null) : null);
  const set = <K extends keyof ProjectInput>(k: K, val: ProjectInput[K]) => setV((p) => ({ ...p, [k]: val }));
  const setComp = (i: number, patch: Partial<Competitor>) =>
    setV((p) => ({ ...p, competitors: p.competitors.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    if (Object.keys(errors).length > 0) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("form [aria-invalid=true]")?.focus());
      return;
    }
    onSubmit({
      ...v,
      name: v.name.trim(),
      siteUrl: v.siteUrl.trim(),
      brandName: v.brandName.trim(),
      locale: v.locale.trim(),
      language: v.language.trim(),
      competitors: v.competitors.map((c) => ({ ...c, name: c.name.trim() })),
    });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Card title="Website and brand">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id={`${idp}-site`}
            label="Website URL"
            type="url"
            inputMode="url"
            autoComplete="url"
            required
            value={v.siteUrl}
            onChange={(e) => set("siteUrl", e.target.value)}
            error={err("siteUrl")}
            hint="https only. Crawling starts only after you verify ownership."
          />
          <SelectField id={`${idp}-type`} label="Site type" value={v.siteType} onChange={(e) => set("siteType", e.target.value as SiteType)}>
            {SITE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </SelectField>
          <TextField
            id={`${idp}-brand`}
            label="Brand name"
            required
            maxLength={LIMITS.brandName}
            value={v.brandName}
            onChange={(e) => {
              const brand = e.target.value;
              setV((p) => ({ ...p, brandName: brand, name: p.name === "" || p.name === p.brandName ? brand : p.name }));
            }}
            error={err("brandName")}
          />
          <TextField
            id={`${idp}-name`}
            label="Project name"
            required
            maxLength={LIMITS.name}
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            error={err("name")}
          />
          <div className="sm:col-span-2">
            <ChipInput
              label="Brand aliases"
              values={v.brandAliases}
              onChange={(next) => set("brandAliases", next)}
              placeholder="Type an alias and press Enter"
              hint="Other names people use for your brand. Used to detect mentions in AI answers."
              max={LIMITS.aliases}
              validate={(s) => (s.length > LIMITS.alias ? `Aliases must be at most ${LIMITS.alias} characters.` : null)}
              error={err("brandAliases")}
            />
          </div>
        </div>
      </Card>

      <Card title="Product and audience">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextArea
              id={`${idp}-product`}
              label="Product description"
              rows={3}
              maxLength={LIMITS.productDescription}
              value={v.productDescription}
              onChange={(e) => set("productDescription", e.target.value)}
              error={err("productDescription")}
              hint={`${v.productDescription.length}/${LIMITS.productDescription}`}
            />
          </div>
          <div className="sm:col-span-2">
            <TextArea
              id={`${idp}-aud`}
              label="Audience"
              rows={2}
              maxLength={LIMITS.audience}
              value={v.audience}
              onChange={(e) => set("audience", e.target.value)}
              error={err("audience")}
              hint="Who buys from you (used to write brand-blind GEO discovery prompts)."
            />
          </div>
          <TextField id={`${idp}-locale`} label="Locale" value={v.locale} onChange={(e) => set("locale", e.target.value)} error={err("locale")} hint="e.g. en-US" />
          <TextField id={`${idp}-lang`} label="Language" value={v.language} onChange={(e) => set("language", e.target.value)} error={err("language")} hint="e.g. en" />
          <div className="sm:col-span-2">
            <TextArea
              id={`${idp}-voice`}
              label="Voice instructions (optional)"
              rows={2}
              maxLength={LIMITS.voice}
              value={v.voice}
              onChange={(e) => set("voice", e.target.value)}
              error={err("voice")}
            />
          </div>
        </div>
      </Card>

      <Card
        title={`Competitors (${v.competitors.length} of ${MAX_COMPETITORS})`}
        description="Names, domains, and aliases. Competitor sites are never crawled automatically."
        actions={
          <Button
            size="sm"
            disabled={v.competitors.length >= MAX_COMPETITORS}
            onClick={() => set("competitors", [...v.competitors, { name: "", domains: [], aliases: [] }])}
          >
            Add competitor
          </Button>
        }
      >
        {v.competitors.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No competitors yet. You can add up to {MAX_COMPETITORS}.</p>
        ) : (
          <ol className="space-y-4">
            {v.competitors.map((c, i) => (
              <li key={i} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <fieldset className="grid gap-3 sm:grid-cols-3">
                  <legend className="sr-only">Competitor {i + 1}</legend>
                  <TextField
                    id={`${idp}-c${i}-name`}
                    label={`Competitor ${i + 1} name`}
                    required
                    value={c.name}
                    onChange={(e) => setComp(i, { name: e.target.value })}
                    error={err(`competitors.${i}.name`)}
                  />
                  <ChipInput
                    label="Domains"
                    values={c.domains}
                    onChange={(next) => setComp(i, { domains: next })}
                    normalize={normalizeDomain}
                    validate={domainError}
                    placeholder="example.com"
                    max={LIMITS.domains}
                    error={err(`competitors.${i}.domains`)}
                  />
                  <ChipInput label="Aliases" values={c.aliases} onChange={(next) => setComp(i, { aliases: next })} placeholder="Alias" max={LIMITS.aliases} />
                </fieldset>
                <div className="mt-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => set("competitors", v.competitors.filter((_, j) => j !== i))}>
                    Remove competitor {i + 1}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {warnings.length > 0 && (
        <StateBanner
          state="setup_required"
          title="Alias collisions (resolve manually)"
          message={
            <ul className="mt-1 list-disc pl-5">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          }
        />
      )}
      {showErrors && Object.keys(errors).length > 0 && (
        <StateBanner state="failed" title="Fix the highlighted fields" message={`${Object.keys(errors).length} field(s) need attention.`} />
      )}
      {serverError}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
