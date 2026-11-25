import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://anilov69.github.io/deriv-quant-platform/"),
  title: "Deriv Quant | Synthetic Indices Workspace",
  description: "Live synthetic-index analytics, payout-aware signals, and guarded trade execution.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#080e17",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
