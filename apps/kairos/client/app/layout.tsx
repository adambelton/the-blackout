import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kairos — admin",
  description: "Spec + profile management for the Kairos narrative engine.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-base-100 text-base-content antialiased">
        {children}
      </body>
    </html>
  );
}
