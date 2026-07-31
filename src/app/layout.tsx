import "~/styles/globals.css";

import { type Metadata } from "next";
import { Fira_Code, Oxanium } from "next/font/google";
import { Toaster } from "sonner";
import { TRPCReactProvider } from "~/clients/trpc";
import { ThemeProvider } from "~/components/core/theme-provider";

const primary = Oxanium({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const code = Fira_Code({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Nimit's Jarvis",
  icons: [
    { rel: "icon", url: "/images/jarvis-logo.png", type: "image/png" },
    { rel: "apple-touch-icon", url: "/images/jarvis-logo.png" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${primary.variable} ${code.variable}`} suppressHydrationWarning>
      <body className="bg-background min-h-screen font-sans antialiased">
        <ThemeProvider>
          <TRPCReactProvider>
            {children}
            <Toaster />
            <div id="dialog-portal" />
          </TRPCReactProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
