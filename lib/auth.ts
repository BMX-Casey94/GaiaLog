import crypto from "node:crypto"
import { cookies } from "next/headers"

const COOKIE_NAME = "gl_admin_session"

function getSecret(): string {
	const secret = process.env.SIMPLE_AUTH_SECRET
	if (!secret) throw new Error("SIMPLE_AUTH_SECRET missing")
	return secret
}

export async function createSession(email: string): Promise<void> {
	const cookieStore = await cookies()
	const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 // 7 days
	const payload = `${email}|${exp}`
	const hmac = crypto.createHmac("sha256", getSecret()).update(payload).digest("hex")
	const token = Buffer.from(`${payload}|${hmac}`).toString("base64url")
	cookieStore.set({
		name: COOKIE_NAME,
		value: token,
		path: "/",
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		maxAge: 60 * 60 * 24 * 7,
	})
}

export async function clearSession(): Promise<void> {
	const cookieStore = await cookies()
	cookieStore.set({ name: COOKIE_NAME, value: "", path: "/", maxAge: 0 })
}

export async function getSessionEmail(): Promise<string | null> {
	const cookieStore = await cookies()
	const raw = cookieStore.get(COOKIE_NAME)?.value
	if (!raw) return null
	try {
		const decoded = Buffer.from(raw, "base64url").toString("utf8")
		const [email, expStr, sig] = decoded.split("|")
		const payload = `${email}|${expStr}`
		const verify = crypto.createHmac("sha256", getSecret()).update(payload).digest("hex")
		if (verify !== sig) return null
		const exp = parseInt(expStr, 10)
		if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null
		return email
	} catch {
		return null
	}
}

export function isEnvAdmin(email: string, password: string): boolean {
	const envEmail = process.env.SIMPLE_ADMIN_EMAIL
	const envPass = process.env.SIMPLE_ADMIN_PASSWORD
	return !!envEmail && !!envPass && email.toLowerCase() === envEmail.toLowerCase() && password === envPass
}


