import { NextResponse } from "next/server"
import { verifyPassword, createAdminSession } from "@/lib/simple-auth"

export async function POST(request: Request) {
	try {
		const { password } = await request.json()
		
		if (!password) {
			return NextResponse.json({ error: "Password required" }, { status: 400 })
		}

		if (await verifyPassword(password)) {
			await createAdminSession()
			return NextResponse.json({ success: true })
		}

		return NextResponse.json({ error: "Invalid password" }, { status: 401 })
	} catch (err) {
		console.error('Sign-in error:', err)
		return NextResponse.json({ error: "Invalid request" }, { status: 400 })
	}
}


