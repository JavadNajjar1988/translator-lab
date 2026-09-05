import { translateMapNames as sharedTranslateMapNames,
  TranslationProviderError, translationQualityIssues as sharedTranslationQualityIssues }
  from "../../../server/translation-provider.mjs";
import { loadOsmIdentitySnapshot } from "../../../server/osm-identity-enrichment.mjs";
import { configureApprovedTranslationMemory } from "../../../server/translation-memory.mjs";

const translationMemoryReady = loadOsmIdentitySnapshot()
  .then((identitySnapshot) => configureApprovedTranslationMemory(identitySnapshot).load());

export type ProviderItem = { key: string; sourceName: string; layer: string; className: string;
  wikidataId?: string; longitude?: number; latitude?: number };
export type ProviderTranslation = { key: string; translatedName: string;
  strategy: "translation" | "transliteration" | "mixed"; provider?: string; nameKind?: string;
  reviewRequired?: boolean; judge?: { provider: string; mode: "shadow"; decision: string;
    suggestedName: string; reasonCode: string } };
export { TranslationProviderError };

export function translationQualityIssues(item: ProviderItem, translatedName: string): string[] {
  return sharedTranslationQualityIssues(item, translatedName);
}

export async function translateMapNames(items: ProviderItem[]): Promise<{
  translations: ProviderTranslation[]; provider: string; memory?: { hits: number; misses: number };
}> {
  await translationMemoryReady;
  return sharedTranslateMapNames(items);
}
