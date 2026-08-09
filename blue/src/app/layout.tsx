import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "talvi — drop a file",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
