import express, { type NextFunction, type Response } from 'express'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import { ProtoWallet } from '@bsv/sdk/wallet'
import { ZodError } from 'zod'

import { appendOverlayAuditLog, assertOverlayAuditConfigured } from './overlay-audit'
import { getOverlayClientAuthConfig, getOverlayServerConfig } from './overlay-config'
import { ensureOverlayServiceReady, lookupOverlaySpendables, submitOverlayTransaction } from './overlay-service'
import { ensureConnected } from './db'

type RateLimitState = {
  windowStartedAt: number
  hits: number
}

function normaliseIp(value: string | null | undefined): string {
  return String(value || '').trim()
}

function createRateLimiter() {
  const state = new Map<string, RateLimitState>()
  const { rateLimitWindowMs, rateLimitMax } = getOverlayServerConfig()

  return function isRateLimited(key: string): boolean {
    const now = Date.now()
    const existing = state.get(key)
    if (!existing || (now - existing.windowStartedAt) >= rateLimitWindowMs) {
      state.set(key, { windowStartedAt: now, hits: 1 })
      return false
    }

    existing.hits += 1
    return existing.hits > rateLimitMax
  }
}

function safeAudit(entry: Parameters<typeof appendOverlayAuditLog>[0]): void {
  try {
    appendOverlayAuditLog(entry)
  } catch (error) {
    console.error('Overlay audit log write failed:', error)
  }
}

function getAllowedIdentityKeys(): Set<string> {
  const serverConfig = getOverlayServerConfig()
  if (serverConfig.allowedIdentityKeys.length > 0) {
    return new Set(serverConfig.allowedIdentityKeys)
  }

  const clientAuth = getOverlayClientAuthConfig()
  if (!clientAuth.identityWif) {
    return new Set()
  }

  return new Set([SDKPrivateKey.fromWif(clientAuth.identityWif).toPublicKey().toString()])
}

function getServerWallet() {
  const { serverIdentityWif } = getOverlayServerConfig()
  if (!serverIdentityWif) {
    throw new Error('GAIALOG_OVERLAY_SERVER_IDENTITY_WIF is required')
  }
  return new ProtoWallet(SDKPrivateKey.fromWif(serverIdentityWif))
}

function getRequestIdentityKey(req: AuthRequest): string | null {
  const identityKey = req.auth?.identityKey
  return identityKey && identityKey !== 'unknown' ? identityKey : null
}

function classifyRouteError(error: unknown): { status: number; message: string } {
  if (error instanceof ZodError) {
    return { status: 400, message: error.issues.map(issue => issue.message).join('; ') || 'Invalid request payload' }
  }

  const message = error instanceof Error ? error.message : String(error)
  if (
    message.includes('required') ||
    message.includes('Unsupported') ||
    message.includes('mismatch') ||
    message.includes('No wallet private keys configured')
  ) {
    return { status: 400, message }
  }

  return { status: 500, message }
}

export async function createOverlayApp() {
  const serverConfig = getOverlayServerConfig()
  assertOverlayAuditConfigured()
  await ensureConnected()
  await ensureOverlayServiceReady()

  const allowedIdentityKeys = getAllowedIdentityKeys()
  const isRateLimited = createRateLimiter()
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: `${serverConfig.jsonLimitBytes}b` }))

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      host: serverConfig.hostId,
      ts: new Date().toISOString(),
    })
  })

  app.use((req, res, next) => {
    if (req.path === '/healthz') {
      next()
      return
    }

    const ip = normaliseIp(req.ip || req.socket.remoteAddress)
    const ipAllowed = serverConfig.allowedIps.length === 0 || serverConfig.allowedIps.includes(ip)
    if (!ipAllowed) {
      safeAudit({
        event: 'overlay.ip_rejected',
        route: req.path,
        outcome: 'rejected',
        ip,
        details: { method: req.method },
      })
      res.status(403).json({ ok: false, error: 'IP not allowed' })
      return
    }

    const rateLimitKey = `${ip}:${req.path}`
    if (isRateLimited(rateLimitKey)) {
      safeAudit({
        event: 'overlay.rate_limited',
        route: req.path,
        outcome: 'rejected',
        ip,
        details: { method: req.method },
      })
      res.status(429).json({ ok: false, error: 'Rate limit exceeded' })
      return
    }

    next()
  })

  app.use(createAuthMiddleware({
    wallet: getServerWallet() as any,
    allowUnauthenticated: false,
    logger: console,
    logLevel: process.env.BSV_LOG_LEVEL === 'debug' ? 'debug' : 'warn',
  }))

  const requireAuthorisedPeer = (route: string) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
      const identityKey = getRequestIdentityKey(req)
      const ip = normaliseIp(req.ip || req.socket.remoteAddress)
      if (!identityKey) {
        safeAudit({
          event: 'overlay.auth_missing',
          route,
          outcome: 'rejected',
          ip,
        })
        res.status(401).json({ ok: false, error: 'Unauthenticated request' })
        return
      }

      if (allowedIdentityKeys.size > 0 && !allowedIdentityKeys.has(identityKey)) {
        safeAudit({
          event: 'overlay.identity_rejected',
          route,
          outcome: 'rejected',
          ip,
          identityKey,
        })
        res.status(403).json({ ok: false, error: 'Identity key not allowed' })
        return
      }

      next()
    }
  }

  app.post('/submit', requireAuthorisedPeer('/submit'), async (req: AuthRequest, res: Response) => {
    const ip = normaliseIp(req.ip || req.socket.remoteAddress)
    const identityKey = getRequestIdentityKey(req)
    try {
      const response = await submitOverlayTransaction(req.body)
      const topics = Object.keys(response.steak)
      safeAudit({
        event: 'overlay.submit',
        route: '/submit',
        outcome: 'ok',
        ip,
        identityKey,
        requestId: String(req.body?.clientRequestId || ''),
        txid: String(req.body?.txid || req.body?.rawTxEnvelope?.txid || ''),
        details: {
          topics,
          outputsAdmitted: topics.reduce((sum, topic) => sum + response.steak[topic].outputsToAdmit.length, 0),
          outputsRemoved: topics.reduce((sum, topic) => sum + response.steak[topic].coinsRemoved.length, 0),
        },
      })
      res.json(response)
    } catch (error) {
      const { status, message } = classifyRouteError(error)
      safeAudit({
        event: 'overlay.submit',
        route: '/submit',
        outcome: status >= 500 ? 'error' : 'rejected',
        ip,
        identityKey,
        requestId: String(req.body?.clientRequestId || ''),
        txid: String(req.body?.txid || req.body?.rawTxEnvelope?.txid || ''),
        details: { message },
      })
      res.status(status).json({ ok: false, error: message })
    }
  })

  app.post('/lookup', requireAuthorisedPeer('/lookup'), async (req: AuthRequest, res: Response) => {
    const ip = normaliseIp(req.ip || req.socket.remoteAddress)
    const identityKey = getRequestIdentityKey(req)
    try {
      const response = await lookupOverlaySpendables(req.body)
      safeAudit({
        event: 'overlay.lookup',
        route: '/lookup',
        outcome: 'ok',
        ip,
        identityKey,
        topic: String(req.body?.query?.topic || ''),
        details: {
          countOnly: req.body?.countOnly === true,
          returned: response.pagination.returned,
          total: response.total,
        },
      })
      res.json(response)
    } catch (error) {
      const { status, message } = classifyRouteError(error)
      safeAudit({
        event: 'overlay.lookup',
        route: '/lookup',
        outcome: status >= 500 ? 'error' : 'rejected',
        ip,
        identityKey,
        topic: String(req.body?.query?.topic || ''),
        details: { message },
      })
      res.status(status).json({ ok: false, error: message })
    }
  })

  return app
}
