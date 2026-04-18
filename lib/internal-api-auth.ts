import { NextResponse } from 'next/server'

export const INTERNAL_API_SECRET_HEADER = 'x-gaialog-internal-secret'

function timingSafeEqualString(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)

  if (leftBytes.length !== rightBytes.length) return false

  let diff = 0
  for (let i = 0; i < leftBytes.length; i++) {
    diff |= leftBytes[i] ^ rightBytes[i]
  }
  return diff === 0
}

export function requireInternalApiAccess(request: Request): NextResponse | null {
  if (process.env.NODE_ENV !== 'production') {
    return null
  }

  const expectedSecret = String(process.env.GAIALOG_INTERNAL_API_SECRET || '').trim()
  if (!expectedSecret) {
    return NextResponse.json(
      {
        error: 'This internal endpoint is disabled in production because GAIALOG_INTERNAL_API_SECRET is not configured.',
      },
      { status: 503 },
    )
  }

  const providedSecret = String(request.headers.get(INTERNAL_API_SECRET_HEADER) || '').trim()
  if (!providedSecret || !timingSafeEqualString(providedSecret, expectedSecret)) {
    return NextResponse.json(
      {
        error: `Forbidden. Supply ${INTERNAL_API_SECRET_HEADER} to access this internal endpoint.`,
      },
      { status: 403 },
    )
  }

  return null
}
