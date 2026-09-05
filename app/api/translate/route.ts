import { NextRequest, NextResponse } from "next/server";
import { translateMapNames, TranslationProviderError } from "./provider";

type TranslationRequest = { sourceName?: string; layer?: string; className?: string;
  wikidataId?: string; longitude?: number; latitude?: number };

export async function POST(request: NextRequest) {
  const body = await request.json() as TranslationRequest;
  const sourceName = body.sourceName?.trim();
  if (!sourceName) return NextResponse.json({ error: "نام مبدأ خالی است و نیازی به ترجمه ندارد." }, { status: 400 });
  try {
    const result = await translateMapNames([{ key: "single", sourceName: sourceName.slice(0, 300),
      layer: body.layer?.slice(0, 100).trim() || "", className: body.className?.slice(0, 100).trim() || "",
      wikidataId: body.wikidataId?.slice(0, 30).trim() || "",
      longitude: Number.isFinite(body.longitude) ? body.longitude : undefined,
      latitude: Number.isFinite(body.latitude) ? body.latitude : undefined }]);
    const translation = result.translations[0];
    return NextResponse.json({ translatedName: translation.translatedName, strategy: translation.strategy,
      provider: translation.provider || result.provider, nameKind: translation.nameKind,
      reviewRequired: translation.reviewRequired === true, judge: translation.judge });
  } catch (error) {
    if (error instanceof TranslationProviderError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "خطای پیش‌بینی‌نشده در مترجم رخ داد." }, { status: 500 });
  }
}
