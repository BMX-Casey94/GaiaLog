import type React from "react"
import type { Metadata } from "next"
import { Space_Grotesk, DM_Sans } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
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

export const metadata: Metadata = {
  title: "GaiaLog - Environmental Blockchain Monitoring",
  description: "Real-time environmental data monitoring with BSV blockchain integration",
  generator: "GaiaLog",
  icons: {
    icon: "/gaialog-logo-128.png",
    apple: "/gaialog-logo-128.png",
  },
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
          {children}
          <footer className="border-t mt-8 text-[10px] text-muted-foreground">
            <div className="max-w-6xl mx-auto px-4 py-3 text-center">
              Environmental data attributions: {" "}
              <a href="https://waqi.info/" target="_blank" rel="noopener noreferrer" className="underline">World Air Quality Index (WAQI)</a>{" • "}
              <a href="https://www.weatherapi.com/" target="_blank" rel="noopener noreferrer" className="underline">WeatherAPI</a>{" • "}
              <a href="https://api.tidesandcurrents.noaa.gov/" target="_blank" rel="noopener noreferrer" className="underline">NOAA Tides & Currents</a>{" • "}
              <a href="https://earthquake.usgs.gov/fdsnws/" target="_blank" rel="noopener noreferrer" className="underline">USGS Earthquake</a>.
              {" "}Attribution required by providers; see their terms.
            </div>
          </footer>
        </ThemeProvider>
      </body>
    </html>
  )
}
