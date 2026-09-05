import { NextRequest, NextResponse } from "next/server";
import { translateMapNames, TranslationProviderError, type ProviderItem } from "../translate/provider";

type BatchItem = { key?: string; sourceName?: string; layer?: string; className?: string;
  wikidataId?: string; longitude?: number; latitude?: number };

export async function POST(request: NextRequest) {
  const body = await request.json() as { items?: BatchItem[] };
  const items: ProviderItem[] = (body.items || []).slice(0, 20).map((item) => ({
    key: item.key?.slice(0, 500).trim() || "", sourceName: item.sourceName?.slice(0, 300).trim() || "",
    layer: item.layer?.slice(0, 100).trim() || "", className: item.className?.slice(0, 100).trim() || "",
    wikidataId: item.wikidataId?.slice(0, 30).trim() || "",
    longitude: Number.isFinite(item.longitude) ? item.longitude : undefined,
    latitude: Number.isFinite(item.latitude) ? item.latitude : undefined,
  }));
  if (!items.length || items.some((item) => !item.key || !item.sourceName)) {
    return NextResponse.json({ error: "فهرست نام‌های قابل ترجمه معتبر نیست." }, { status: 400 });
  }
  try {
    return NextResponse.json(await translateMapNames(items));
  } catch (error) {
    if (error instanceof TranslationProviderError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "خطای پیش‌بینی‌نشده در مترجم رخ داد." }, { status: 500 });
  }
}
