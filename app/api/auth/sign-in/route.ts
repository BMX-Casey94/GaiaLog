import { NextResponse } from "next/server"
import { verifyPassword, createAdminSession } from "@/lib/simple-auth"

export async function POST(request: Request) {
	try {
		const { password } = await request.json()
		console.log('[DEBUG] Received password attempt')
		console.log('[DEBUG] ADMIN_PASSWORD is set:', !!process.env.ADMIN_PASSWORD)
		
		if (!password) {
			return NextResponse.json({ error: "Password required" }, { status: 400 })
		}

		if (await verifyPassword(password)) {
			console.log('[DEBUG] Password verified, creating session')
			await createAdminSession()
			return NextResponse.json({ success: true })
		}

		console.log('[DEBUG] Password verification failed')
		return NextResponse.json({ error: "Invalid password" }, { status: 401 })
	} catch (err) {
		console.error('[DEBUG] Error:', err)
		return NextResponse.json({ error: "Invalid request" }, { status: 400 })
	}
}


