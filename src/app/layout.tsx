import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ticker — Trade the Game, Live",
  description: "A live stock market for sports. Buy, sell, and short players while a simulated match moves the market in real time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
