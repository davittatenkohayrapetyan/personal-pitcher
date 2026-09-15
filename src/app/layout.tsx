import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: 'Davit Hayrapetyan – AI Systems & Backend Architecture',
  description:
    'Ask anything about Davit Hayrapetyan — PhD, Staff Software Engineer, and backend architect who builds AI systems. This site runs its own four-tier LLM fallback chain — starting on a model hosted at home — with live circuit breakers shown under every answer.',
  keywords: [
    'Davit Hayrapetyan',
    'backend architect',
    'AI systems',
    'distributed systems',
    'PhD engineering',
    'Armenia',
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
