import type { Metadata } from "next"
import type React from "react"

export const metadata: Metadata = {
  title: "Admin Login",
  robots: { index: false, follow: false },
  // Prevents inheriting the root layout's `canonical: "/"`.
  alternates: { canonical: "/login" },
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
