import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pitch Exchange — Fantasy Soccer Stock Market",
  description: "Trade shares in soccer players priced by a live LMSR market during a simulated match.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
