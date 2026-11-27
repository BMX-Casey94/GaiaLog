import type React from "react"
import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { isAdminAuthenticated } from "@/lib/simple-auth"

export const metadata: Metadata = {
  title: "Admin Dashboard",
  robots: { index: false, follow: false },
  // Without this, the admin page inherits `canonical: "/"` from the root
  // layout and tells crawlers it is a duplicate of the homepage.
  alternates: { canonical: "/admin" },
}

// Rendered per request so the auth check below runs on every hit rather than
// being captured into a static shell.
export const dynamic = "force-dynamic"

export default async function AdminLayout({
	children,
}: {
	children: React.ReactNode
}) {
	const isAuth = await isAdminAuthenticated()
	if (!isAuth) {
		redirect("/login")
	}

	return <main className="min-h-screen bg-background">{children}</main>
}
