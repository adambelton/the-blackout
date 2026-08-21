import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import { PostHogProvider } from "./providers";

const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  axes: ["opsz"],
});

export const metadata: Metadata = {
  title: "The Blackout — Live football narrative",
  description:
    "An experiment in real-time AI orchestration that turns live football matches into literary audiobooks — shared simultaneously in a live social room.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={dmSans.className}>
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: "#FDFAF4",
          WebkitFontSmoothing: "antialiased",
          color: "#1F1A14",
        }}
      >
        <PostHogProvider>{children}</PostHogProvider>
      </body>
    </html>
  );
}
