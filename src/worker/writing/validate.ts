/**
 * [A10]/[A17] Output validator. OWNED BY: runtime module (agent F). Signature is the contract.
 * Rejects drafts that cite unknown evidence ids, contain numeric specs/certifications/metrics not
 * present in cited evidence, or make guarantee claims. Missing facts must be "[confirm: ...]".
 */
export interface ValidationEvidence {
  id: string;
  text: string;
  data?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  confirmPlaceholders: string[];
}

export function validateDraft(_textFields: string[], _citedEvidenceIds: string[], _evidence: ValidationEvidence[]): ValidationResult {
  throw new Error("validateDraft: not implemented yet (runtime module)");
}
