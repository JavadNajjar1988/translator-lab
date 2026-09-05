import type { Metadata } from "next";
import TranslatorLab from "./TranslatorLab";

export const metadata: Metadata = {
  title: "آزمایشگاه ترجمه نام‌های نقشه",
  description: "محیط محلی برای بررسی، ترجمه و کنترل نام عوارض نقشه",
};

export default function Home() {
  return <TranslatorLab />;
}
