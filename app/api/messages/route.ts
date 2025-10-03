import { NextResponse } from 'next/server'
export const runtime = 'nodejs'
import { z } from 'zod'
import { getContactMessagesPage, insertContactMessage, markContactMessageRead, setContactMessageArchived } from '@/lib/repositories'
import { verifyCaptchaToken } from '@/lib/simple-captcha'

const postSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  message: z.string().min(1).max(3000),
  captchaToken: z.string().min(1),
})

export async function POST(req: Request) {
  try {
    const json = await req.json()
    const parsed = postSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
    }
    const ok = await verifyCaptchaToken(parsed.data.captchaToken)
    if (!ok) return NextResponse.json({ error: 'Captcha failed' }, { status: 400 })
    const { name, email, message } = parsed.data
    await insertContactMessage({ name, email, message })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('POST /api/messages error', e)
    return NextResponse.json({ error: 'Failed to save message' }, { status: 500 })
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const limit = Math.min(Number(searchParams.get('limit') || 20), 100)
    const page = Math.max(Number(searchParams.get('page') || 1), 1)
    const offset = (page - 1) * limit
    const rows = await getContactMessagesPage({ offset, limit })
    return NextResponse.json({ items: rows, page, limit })
  } catch (e) {
    console.error('GET /api/messages error', e)
    return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json()
    const id = Number(body.id)
    const { read, archived } = body
    
    if (!Number.isFinite(id)) {
      console.error('Invalid id received:', body.id, 'type:', typeof body.id)
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }
    
    if (read === true) await markContactMessageRead(id)
    if (typeof archived === 'boolean') await setContactMessageArchived(id, archived)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('PATCH /api/messages error', e)
    return NextResponse.json({ error: 'Failed to update message' }, { status: 500 })
  }
}


