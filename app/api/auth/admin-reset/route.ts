import { NextResponse } from "next/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { requireInternalApiAccess } from "@/lib/internal-api-auth"

export async function POST(request: Request) {
	const denied = requireInternalApiAccess(request)
	if (denied) return denied

	const resetSecret = process.env.ADMIN_RESET_SECRET
	if (!resetSecret) return NextResponse.json({ error: "Reset secret not configured" }, { status: 500 })

	try {
		const { secret, email, password } = await request.json()
		if (secret !== resetSecret) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
		if (!email || !password) return NextResponse.json({ error: "Email and password required" }, { status: 400 })

		const supabase = createSupabaseAdminClient()
		// Try to find user then update, else create
		let foundUserId: string | undefined
		let page = 1
		const perPage = 100
		while (!foundUserId) {
			const list = await supabase.auth.admin.listUsers({ page, perPage })
			if (list.error) return NextResponse.json({ error: list.error.message }, { status: 500 })
			const match = list.data.users.find(u => u.email?.toLowerCase() === (email as string).toLowerCase())
			if (match) { foundUserId = match.id; break }
			if (list.data.users.length < perPage) break
			page += 1
		}

		if (foundUserId) {
			const update = await supabase.auth.admin.updateUserById(foundUserId, {
				password,
				email_confirm: true,
				app_metadata: { role: 'admin' },
			})
			if (update.error) return NextResponse.json({ error: update.error.message }, { status: 500 })
			return NextResponse.json({ success: true, updated: true })
		}

		const create = await supabase.auth.admin.createUser({
			email,
			password,
			email_confirm: true,
			app_metadata: { role: 'admin' },
		})
		if (create.error) return NextResponse.json({ error: create.error.message }, { status: 500 })
		return NextResponse.json({ success: true, created: true })
	} catch (e: any) {
		return NextResponse.json({ error: e?.message || 'Invalid request' }, { status: 400 })
	}
}


