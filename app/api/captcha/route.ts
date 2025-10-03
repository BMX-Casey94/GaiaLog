import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { generateCaptcha } from '@/lib/simple-captcha'

export async function GET() {
  const { question, token } = generateCaptcha()
  return NextResponse.json({ question, token })
}


