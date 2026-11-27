/**
 * WhatsOnChain links and transaction-id validation for client components.
 *
 * The network is hard-coded to mainnet. `BSV_NETWORK` is a server-only
 * environment variable, so reading it in a component would resolve to
 * `undefined` in the browser and silently produce testnet links for mainnet
 * transactions.
 */

const WOC_TX_BASE = "https://whatsonchain.com/tx"

/** True for a 64-character hexadecimal transaction id. */
export function isValidTxid(txid: string | null | undefined): boolean {
  return typeof txid === "string" && /^[0-9a-f]{64}$/i.test(txid)
}

/** Mainnet WhatsOnChain transaction URL. */
export function getExplorerUrl(txid: string): string {
  return `${WOC_TX_BASE}/${encodeURIComponent(txid)}`
}
