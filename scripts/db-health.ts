import 'dotenv/config'
import { ensureConnected } from '@/lib/db'

async function main() {
  try {
    await ensureConnected()
    console.log('DB OK')
    process.exit(0)
  } catch (err) {
    console.error('DB ERROR OBJECT:', err)
    const e = err as Error
    console.error('DB ERROR MESSAGE:', e && e.message)
    console.error('DB ERROR STACK:', e && e.stack)
    process.exit(1)
  }
}

main()


