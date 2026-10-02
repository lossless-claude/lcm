/** Model selection and accounting labels share this protocol definition. */
export const COMPACTION_SUMMARY_MODELS = {
  pool: { providerId: null, label: "Configured pipeline" },
  haiku: { providerId: "session:haiku", label: "Live session (haiku)" },
  sonnet: { providerId: "session:sonnet", label: "Live session (sonnet)" },
  session: { providerId: "session:fork", label: "Live session (fork)" },
} as const;

export type CompactionSummaryModel = keyof typeof COMPACTION_SUMMARY_MODELS;
export type RequesterSummaryModel = Exclude<CompactionSummaryModel, "pool">;
export type SessionSummaryProviderId = (typeof COMPACTION_SUMMARY_MODELS)[RequesterSummaryModel]["providerId"];
export const DEFAULT_COMPACTION_SUMMARY_MODEL: CompactionSummaryModel = "pool";

export function validCompactionSummaryModel(value: unknown): value is CompactionSummaryModel {
  return typeof value === "string" && Object.hasOwn(COMPACTION_SUMMARY_MODELS, value);
}

export function validSessionSummaryProviderId(value: unknown): value is SessionSummaryProviderId {
  return typeof value === "string" && Object.values(COMPACTION_SUMMARY_MODELS).some(model => model.providerId === value);
}

export function sessionSummaryProviderId(model: RequesterSummaryModel): SessionSummaryProviderId {
  return COMPACTION_SUMMARY_MODELS[model].providerId;
}

export function sessionSummaryProviderLabel(providerId: string): string | undefined {
  return Object.values(COMPACTION_SUMMARY_MODELS).find(model => model.providerId === providerId)?.label;
}
