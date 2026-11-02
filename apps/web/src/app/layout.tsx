import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CURSOR_CSS } from "../lib/cursors";
import "./globals.css";

export const metadata: Metadata = {
  title: "Finite",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{CURSOR_CSS}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
