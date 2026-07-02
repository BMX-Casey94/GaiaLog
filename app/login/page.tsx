"use client"

import { useState, FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

export default function LoginPage() {
	const router = useRouter()
	const [password, setPassword] = useState<string>("")
	const [loading, setLoading] = useState<boolean>(false)
	const [error, setError] = useState<string | null>(null)

	async function onSubmit(e: FormEvent) {
		e.preventDefault()
		setLoading(true)
		setError(null)
		try {
			const res = await fetch("/api/auth/sign-in", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			})
			const data = await res.json()
			if (!res.ok) {
				throw new Error(data.error || "Sign-in failed")
			}
			router.replace("/admin")
		} catch (err: any) {
			setError(err.message || "Sign-in failed")
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-black via-slate-950 to-black">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0"
				style={{
					background: `radial-gradient(ellipse at center, rgba(88, 28, 135, 0.25) 0%, rgba(59, 7, 100, 0.15) 40%, transparent 75%)`,
				}}
			/>
			<Card className="relative w-full max-w-sm glass-card border-slate-700/50 bg-slate-900/60 text-white">
				<CardHeader>
					<CardTitle className="font-display text-2xl">Admin login</CardTitle>
					<CardDescription className="text-slate-400">Enter the admin password to continue</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={onSubmit} className="grid gap-4">
						<div className="grid gap-2">
							<Label htmlFor="password" className="text-slate-300">Password</Label>
							<Input
								id="password"
								type="password"
								required
								autoComplete="current-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="bg-black/40 border-slate-600/50 text-white focus:border-purple-500"
							/>
						</div>
						{error && (
							<p className="text-red-400 text-sm" role="alert">
								{error}
							</p>
						)}
						<Button type="submit" variant="purple" disabled={loading}>
							{loading ? "Signing in…" : "Sign in"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	)
}


