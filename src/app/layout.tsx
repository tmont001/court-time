import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Court Time",
  description: "Tennis court booking platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/*
       * bg-gray-200 on the body gives a visible backdrop on wide screens so
       * the 430 px mobile-preview card stands out. On real mobile the body
       * fills the viewport anyway, so the gray is invisible.
       */}
      <body className="bg-gray-200 text-gray-900 antialiased">
        <div className="mx-auto w-full max-w-[430px] md:max-w-full min-h-screen bg-white">
          {children}
        </div>
      </body>
    </html>
  );
}
