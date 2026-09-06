import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KAVACH — Event-Aware Capital Governor",
  description:
    "A production-grade decision-support console for an autonomous capital agent: an optimizer that proposes, a constitution that disposes, real news perceived by Gemini, AI voices (advisor + critic) in the loop with zero authority, human consent on tap, and a hash-chained flight recorder that proves every choice — on three replayed Indian crises and a live paper book.",
  keywords: [
    "KAVACH",
    "risk management",
    "CVaR",
    "Indian markets",
    "SEBI",
    "liquidity",
    "capital governor",
    "AI governance",
    "Gemini",
  ],
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "KAVACH — Event-Aware Capital Governor",
    description:
      "The optimizer proposes. The constitution disposes. The recorder remembers. Educational simulation — never places real orders.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
