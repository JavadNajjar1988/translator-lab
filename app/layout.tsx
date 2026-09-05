import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "آزمایشگاه ترجمه نام‌های نقشه",
  description: "محیط محلی کنترل ترجمه عوارض نقشه",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
