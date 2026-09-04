import type { Metadata } from "next";
import { Source_Sans_3, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const sourceSans = Source_Sans_3({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-source-sans",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-source-serif",
});

export const metadata: Metadata = {
  title: {
    default: "AMR Resistance Copilot",
    template: "%s",
  },
  description:
    "Structure-grounded mechanistic interpretation of antimicrobial-resistance mutations.",
  applicationName: "AMR Resistance Copilot",
  keywords: [
    "antimicrobial resistance",
    "AMR",
    "structure",
    "mutation",
    "genomics",
    "drug target",
  ],
  openGraph: {
    title: "AMR Resistance Copilot",
    description:
      "Structure-grounded mechanistic interpretation of antimicrobial-resistance mutations.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AMR Resistance Copilot",
    description:
      "Structure-grounded mechanistic interpretation of antimicrobial-resistance mutations.",
  },
};

/**
 * `suppressHydrationWarning` on the two outermost elements, and nowhere else.
 *
 * Browser extensions stamp attributes onto <html> and <body> before React hydrates -
 * data-solvely-extension, Grammarly's data-gr-ext-installed, most theme and AI extensions -
 * and React then reports a hydration mismatch for markup this app did not write and cannot
 * control. On a laptop that is not the developer's, that is a red overlay over the demo.
 *
 * The flag is one level deep: it tells React to accept the DOM's attributes for *this*
 * element only. Hydration mismatches anywhere inside - which would be our bug - are still
 * reported normally. Both elements here carry only static class names, so there is nothing
 * real for it to hide.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sourceSans.variable} ${sourceSerif.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full font-sans" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
