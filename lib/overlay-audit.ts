import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { getOverlayServerConfig } from './overlay-config'

export interface OverlayAuditEntry {
  event: string
  route: string
  outcome: 'ok' | 'rejected' | 'error'
  requestId?: string | null
  txid?: string | null
  topic?: string | null
  ip?: string | null
  identityKey?: string | null
  details?: Record<string, unknown>
}

function getAuditLogPath(): string {
  const configured = String(process.env.GAIALOG_OVERLAY_AUDIT_LOG_PATH || '').trim()
  if (configured) return configured
  return path.join(process.cwd(), 'logs', 'overlay-audit.log')
}

export function assertOverlayAuditConfigured(): void {
  const { auditHmacSecret } = getOverlayServerConfig()
  if (!auditHmacSecret) {
    throw new Error('GAIALOG_OVERLAY_AUDIT_HMAC_SECRET is required for signed overlay audit logs')
  }
}

export function appendOverlayAuditLog(entry: OverlayAuditEntry): void {
  const { auditHmacSecret, hostId } = getOverlayServerConfig()
  if (!auditHmacSecret) {
    throw new Error('Cannot write signed overlay audit log without GAIALOG_OVERLAY_AUDIT_HMAC_SECRET')
  }

  const payload = {
    hostId,
    timestamp: new Date().toISOString(),
    ...entry,
  }

  const encodedPayload = JSON.stringify(payload)
  const signature = crypto
    .createHmac('sha256', auditHmacSecret)
    .update(encodedPayload)
    .digest('hex')

  const line = JSON.stringify({ payload, signature })
  const logPath = getAuditLogPath()
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${line}\n`, { encoding: 'utf8' })
}
