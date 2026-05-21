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
      <body className="bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 antialiased">
        <div className="mx-auto w-full max-w-[430px] sm:max-w-full min-h-screen bg-white dark:bg-gray-900">
          {children}
        </div>
      </body>
    </html>
  );
}
