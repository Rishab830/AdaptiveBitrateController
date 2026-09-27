import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flux — Adaptive P2P Streaming",
  description: "Direct device-to-device streaming with tabular Q-learning bitrate control.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#070b14" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
