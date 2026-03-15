import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import { bsvConfig } from './bsv-config'

export interface TreasuryTopicBinding {
  walletIndex: number
  address: string
  topic: string
}

function cleanSegment(value: string | undefined, fallback: string): string {
  const safe = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '')
  return safe || fallback
}

export function getTreasuryTopicPrefix(): string {
  return cleanSegment(process.env.BSV_TREASURY_TOPIC_PREFIX, 'TREASURY')
}

export function getTreasuryTopicVersion(): string {
  return cleanSegment(process.env.BSV_TREASURY_TOPIC_VERSION, 'v1')
}

export function getTreasuryTopicForWallet(walletIndex: number): string {
  const walletLabel = `W${Math.max(1, walletIndex + 1)}`
  return `${getTreasuryTopicPrefix()}:${getTreasuryTopicVersion()}:${walletLabel}`
}

export function getTreasuryWalletTopicBindings(): TreasuryTopicBinding[] {
  return (bsvConfig.wallets.privateKeys || [])
    .filter(Boolean)
    .map((wif, walletIndex) => {
      try {
        const address = SDKPrivateKey.fromWif(wif).toPublicKey().toAddress().toString()
        return {
          walletIndex,
          address,
          topic: getTreasuryTopicForWallet(walletIndex),
        }
      } catch {
        return null
      }
    })
    .filter((binding): binding is TreasuryTopicBinding => Boolean(binding))
}

export function getTreasuryBindingForAddress(address: string): TreasuryTopicBinding | null {
  return getTreasuryWalletTopicBindings().find(binding => binding.address === address) || null
}

export function getTreasuryBindingForTopic(topic: string): TreasuryTopicBinding | null {
  return getTreasuryWalletTopicBindings().find(binding => binding.topic === topic) || null
}
