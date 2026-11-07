import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Next app fixture" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
