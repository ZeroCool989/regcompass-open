import type { Metadata } from "next";
import "./globals.css";
import { Navbar } from "@/components/Navbar";
import { AegisNotificationBanner } from "@/components/AegisNotificationBanner";
import { KB } from "@/lib/kb";

export const metadata: Metadata = {
  title: "RegCompass | Regulatorische KI-Analyse fuer den Finanzsektor",
  description: `Regulatorische Compliance-Analyse fuer KI im Finanzsektor — ${KB.stats.totalRequirements} Anforderungen, ${KB.stats.totalControls} Kontrollen, ${KB.regulations.length} Regulierungen.`,
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'RegCompass',
    description: 'Regulatorische Compliance-Analyse fuer KI im Finanzsektor',
    type: 'website',
    locale: 'de_DE',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className="h-full antialiased dark" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Navbar />
        <AegisNotificationBanner />
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
