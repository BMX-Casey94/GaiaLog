import crypto from 'crypto'

// Simple stateless captcha based on HMAC; avoids server-side storage.
// We encode: question, answer, issuedAt, and sign with a server secret.

function getSecret(): string {
  const secret = process.env.CAPTCHA_SECRET || process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET
  if (!secret) {
    // Last resort: derive from NODE_ENV; not secure but prevents crash in dev
    return 'dev-secret-change-me'
  }
  return secret
}

export function generateCaptcha(): { question: string; token: string } {
  const a = Math.floor(Math.random() * 9) + 1
  const b = Math.floor(Math.random() * 9) + 1
  const answer = a + b
  const issuedAt = Date.now()
  const payload = `${a}+${b}|${answer}|${issuedAt}`
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url')
  const token = Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url')
  return { question: `What is ${a} + ${b}?`, token }
}

export async function verifyCaptchaToken(tokenWithUser: string): Promise<boolean> {
  try {
    const [token, userAns] = tokenWithUser.split('|')
    const raw = Buffer.from(token, 'base64url').toString('utf8')
    const [expr, answerStr, issuedAtStr, sig] = raw.split('|')
    if (!expr || !answerStr || !issuedAtStr || !sig) return false
    const check = crypto.createHmac('sha256', getSecret()).update(`${expr}|${answerStr}|${issuedAtStr}`).digest('base64url')
    if (check !== sig) return false
    const issuedAt = Number(issuedAtStr)
    if (!Number.isFinite(issuedAt)) return false
    // Expire after 5 minutes
    if (Date.now() - issuedAt > 5 * 60 * 1000) return false
    // Ensure provided answer is correct (redundant as it's signed, but keep to be explicit)
    const [aStr, bStr] = expr.split('+')
    const expected = Number(aStr) + Number(bStr)
    if (expected !== Number(answerStr)) return false
    if (Number(userAns) !== expected) return false
    return true
  } catch {
    return false
  }
}


