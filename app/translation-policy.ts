export type TranslationRecord = {
  sourceName?: string;
  translatedName?: string;
  editRequested?: boolean;
};

export type TranslationDecision =
  | "skip_no_source"
  | "skip_translated"
  | "translate_new"
  | "retranslate";

export function decideTranslation(record: TranslationRecord): TranslationDecision {
  const sourceName = record.sourceName?.trim() || "";
  const translatedName = record.translatedName?.trim() || "";

  if (!sourceName) return "skip_no_source";
  if (record.editRequested) return "retranslate";
  if (translatedName) return "skip_translated";
  return "translate_new";
}

export function summarizeTranslationQueue(records: TranslationRecord[]) {
  return records.reduce((summary, record) => {
    summary[decideTranslation(record)] += 1;
    return summary;
  }, {
    skip_no_source: 0,
    skip_translated: 0,
    translate_new: 0,
    retranslate: 0,
  });
}
