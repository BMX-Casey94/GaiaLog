import type React from "react"
import type { Metadata, Viewport } from "next"
import { Space_Grotesk, DM_Sans } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Navigation } from "@/components/navigation"
import "@/lib/worker-bootstrap" // Auto-initialize workers on app startup

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-space-grotesk",
})

const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-dm-sans",
})

const SITE_URL = "https://gaialog.world"
const SITE_DESCRIPTION =
  "Real-time environmental monitoring — air quality, water levels, seismic activity and more — with every measurement recorded immutably on the BSV blockchain."

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "GaiaLog — Environmental Blockchain Monitoring",
    template: "%s | GaiaLog",
  },
  description: SITE_DESCRIPTION,
  applicationName: "GaiaLog",
  keywords: [
    "environmental monitoring",
    "blockchain",
    "BSV",
    "air quality",
    "water levels",
    "seismic activity",
    "immutable data",
    "environmental data",
  ],
  authors: [{ name: "GaiaLog" }],
  creator: "GaiaLog",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_GB",
    url: SITE_URL,
    siteName: "GaiaLog",
    title: "GaiaLog — Environmental Blockchain Monitoring",
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "GaiaLog — Environmental Blockchain Monitoring",
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: "/gaialog-logo-128.png",
    apple: "/gaialog-logo-128.png",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1120" },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${spaceGrotesk.variable} ${dmSans.variable}`}>
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {/*
            Navigation is hoisted into the root layout so the navbar element
            (and its framer-motion `layoutId="lamp"` shared-layout anchor)
            stays mounted across route transitions. When it lived inside each
            page, navigating from `/` to `/explorer` unmounted the source
            navbar and remounted a new one, which caused framer-motion's
            shared-layout reconciliation to silently abort the App Router
            transition (the RSC payload was fetched but the URL never
            committed, leaving Data Explorer "highlighted but stuck").
          */}
          <Navigation />
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
