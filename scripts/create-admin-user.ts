import { config as dotenvConfig } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
// Load .env.local first (Next.js convention), then fallback to .env
const envLocalPath = resolve(process.cwd(), '.env.local')
if (existsSync(envLocalPath)) {
	dotenvConfig({ path: envLocalPath })
} else {
	dotenvConfig()
}
import { createClient } from '@supabase/supabase-js'

async function main() {
	const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
	const adminEmail = process.env.ADMIN_EMAIL
	const adminPassword = process.env.ADMIN_PASSWORD
	if (!adminEmail || !adminPassword) {
		throw new Error('Missing ADMIN_EMAIL or ADMIN_PASSWORD in environment')
	}

	if (!supabaseUrl || !serviceRoleKey) {
		throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment')
	}

	const supabase = createClient(supabaseUrl, serviceRoleKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	})

	// Always try to find existing user first
	let foundUserId: string | undefined
	let page = 1
	const perPage = 100
	while (!foundUserId) {
		const list = await supabase.auth.admin.listUsers({ page, perPage })
		if (list.error) throw list.error
		const match = list.data.users.find(u => u.email?.toLowerCase() === adminEmail.toLowerCase())
		if (match) {
			foundUserId = match.id
			break
		}
		if (list.data.users.length < perPage) break
		page += 1
	}

	if (foundUserId) {
		const update = await supabase.auth.admin.updateUserById(foundUserId, {
			password: adminPassword,
			email_confirm: true,
			app_metadata: { role: 'admin' },
		})
		if (update.error) throw update.error
		console.log('Admin user updated:', foundUserId)
		return
	}

	// Not found: create fresh
	const create = await supabase.auth.admin.createUser({
		email: adminEmail,
		password: adminPassword,
		email_confirm: true,
		app_metadata: { role: 'admin' },
	})
	if (create.error) throw create.error
	console.log('Admin user created:', create.data.user?.id)
}

main().catch((err) => {
	console.error('Failed to ensure admin user:', err?.message || err)
	process.exit(1)
})


