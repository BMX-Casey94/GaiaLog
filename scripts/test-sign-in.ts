import { config as dotenvConfig } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
const envLocalPath = resolve(process.cwd(), '.env.local')
if (existsSync(envLocalPath)) dotenvConfig({ path: envLocalPath })
else dotenvConfig()

import { createClient } from '@supabase/supabase-js'

async function main() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL
	const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
	const email = process.env.ADMIN_EMAIL || 'corsacasey@gmail.com'
	const password = 'Zy2mzx12'
	if (!url || !anon) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY')
	const supabase = createClient(url, anon)
	const { data, error } = await supabase.auth.signInWithPassword({ email, password })
	if (error) {
		console.error('Client sign-in failed:', error.message)
		process.exit(1)
	}
	console.log('Client sign-in ok. User:', data.user?.id)
}

main().catch((e) => {
	console.error('Test failed:', e?.message || e)
	process.exit(1)
})


