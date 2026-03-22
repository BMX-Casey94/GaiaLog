/**
 * Load env for CLI/scripts: `.env` first, then `.env.local` (overrides).
 * Import this as the first side-effect import so `process.env` is complete before lib modules initialise.
 */
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

const root = process.cwd()
const envPath = path.join(root, '.env')
const localPath = path.join(root, '.env.local')

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
}
if (fs.existsSync(localPath)) {
  dotenv.config({ path: localPath, override: true })
}
