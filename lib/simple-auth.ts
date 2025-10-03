import { cookies } from "next/headers"
import crypto from "node:crypto"

const COOKIE_NAME = "admin_session"
const SESSION_DURATION = 60 * 60 * 24 * 7 // 7 days

function getSecret(): string {
	return process.env.ADMIN_SECRET || "change-me-in-production"
}

function getAdminPassword(): string {
	return process.env.ADMIN_PASSWORD || ""
}

export async function verifyPassword(password: string): Promise<boolean> {
	const adminPassword = getAdminPassword()
	return adminPassword.length > 0 && password === adminPassword
}

export async function createAdminSession(): Promise<void> {
	const store = await cookies()
	const expires = Date.now() + SESSION_DURATION * 1000
	const token = `${expires}:${crypto.randomBytes(32).toString("hex")}`
	const signature = crypto.createHmac("sha256", getSecret()).update(token).digest("hex")
	const value = `${token}:${signature}`

	store.set({
		name: COOKIE_NAME,
		value,
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		maxAge: SESSION_DURATION,
		path: "/",
	})
}

export async function clearAdminSession(): Promise<void> {
	const store = await cookies()
	store.delete(COOKIE_NAME)
}

export async function isAdminAuthenticated(): Promise<boolean> {
	const store = await cookies()
	const cookie = store.get(COOKIE_NAME)
	if (!cookie?.value) return false

	try {
		const parts = cookie.value.split(":")
		if (parts.length !== 3) return false
		const [expiresStr, random, signature] = parts
		const token = `${expiresStr}:${random}`
		const expected = crypto.createHmac("sha256", getSecret()).update(token).digest("hex")
		if (signature !== expected) return false
		const expires = parseInt(expiresStr, 10)
		if (isNaN(expires) || expires < Date.now()) return false
		return true
	} catch {
		return false
	}
}

