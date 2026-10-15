import type { Metadata, Viewport } from "next";
import "./globals.css";

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><rect x="1" y="1" width="16" height="16" rx="2" fill="#fff" stroke="#256abf" stroke-width="1.6"/><path d="M1 9h6M11 9h6" stroke="#256abf" stroke-width="1.6"/><path d="M8 9h2" stroke="#d03b3b" stroke-width="2.2"/></svg>',
  );

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_STATIC_DEMO === "1" ? "ScanGap Demo" : "ScanGap",
  icons: { icon: ICON },
  description: "Coverage, scan-plan and scope QA for reality-capture crews — before demobilizing.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="border-b border-line bg-panel">
          <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="text-accent">
              <rect x="1" y="1" width="16" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M1 9h6M11 9h6" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8 9h2" stroke="rgb(var(--sev-high))" strokeWidth="2.2" />
            </svg>
            <span className="font-semibold tracking-tight">ScanGap</span>
            <span className="hidden text-xs text-muted sm:inline">· did we capture what the client asked for, at the accuracy they asked for?</span>
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
