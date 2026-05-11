import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Davit Hayrapetyan – Personal AI Pitch',
  description: 'Ask anything about Davit Hayrapetyan – software engineer, open source contributor, and builder from Armenia.',
  keywords: ['Davit Hayrapetyan', 'software engineer', 'Armenia', 'TypeScript', 'open source'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
