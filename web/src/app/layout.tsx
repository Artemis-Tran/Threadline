import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Threadline",
  description: "Read a book alongside its extracted thread of characters, relationships, and events.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
