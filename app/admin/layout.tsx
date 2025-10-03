import type React from "react"
import { redirect } from "next/navigation"
import { isAdminAuthenticated } from "@/lib/simple-auth"

export default async function AdminLayout({
	children,
}: {
	children: React.ReactNode
}) {
	const isAuth = await isAdminAuthenticated()
	if (!isAuth) {
		redirect("/login")
	}

	return <div className="min-h-screen bg-background">{children}</div>
}
