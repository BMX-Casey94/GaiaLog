/**
 * SPV verification of a merkle proof against a block header.
 *
 * Three separate facts are established here, and they are deliberately kept
 * separate because they have different strengths:
 *
 *   1. `validBump` — the BRC-74 BUMP parses and commits to this txid at a
 *      stated height. This is arithmetic on the caller's own input.
 *   2. `rootMatchesHeader` — the root the BUMP computes equals the `merkleRoot`
 *      of the header at that height. This says the proof agrees with a header;
 *      it says nothing about whether the header is real.
 *   3. `spvVerified` — the header was chain-verified (proved against its
 *      parent, or fetched from an operator-controlled Chaintracks). Only then
 *      is inclusion in the canonical chain evidenced.
 *
 * Collapsing 2 into 3 is the failure mode that matters: any host can serve a
 * header, so root equality alone proves that *someone* built a header with that
 * root. Rows that reach `spv_verified = true` feed `BSV_MIN_SPEND_CONFIRMATIONS`
 * and the explorer's confirmed-only view, so the distinction is load-bearing.
 *
 * ## The forged single-leaf BUMP
 *
 * `MerklePath.fromCoinbaseTxidAndHeight(txid, height)` produces
 * `[[{offset: 0, hash: txid, txid: true}]]`, whose `computeRoot(txid)` returns
 * the txid itself. Anyone can construct that for any txid at any height, and
 * anyone can also serve a header claiming that root — so on its own it proves
 * nothing at all.
 *
 * A single-leaf path is not always a forgery: a block containing exactly one
 * transaction has exactly that shape, and its root genuinely is the coinbase
 * txid. The two cases are only distinguishable by the header's transaction
 * count, which a BUMP does not carry. So a single-leaf proof is accepted as
 * `validBump` (the arithmetic is sound) but only reaches `spvVerified` when the
 * header was chain-verified *and* the txid is a coinbase candidate — which
 * cannot be established here. It therefore never sets `spvVerified` on its own,
 * and callers get `reason` explaining why.
 */

import { MerklePath } from '@bsv/sdk'
import {
  getHeaderByHeight,
  isLocallyVerified,
  isSelfHostedChaintracks,
  verifyHeaderAgainstParent,
  type BlockHeaderInfo,
} from './chaintracks-client'

export interface VerifyMerkleProofInput {
  txid: string
  /** Hex BRC-74 BUMP, e.g. the `merklePath` field from an ARC/Broadcaster status. */
  merklePathHex: string
  /** Height the caller believes the transaction is in. Must agree with the BUMP. */
  claimedBlockHeight?: number | null
  /** Block hash the caller believes holds it. Must agree with the header. */
  claimedBlockHash?: string | null
  /**
   * Set when the caller has already proved this header (for example the SSE
   * subscriber, which verifies once per block). Skips the network round trip
   * but still requires root equality.
   */
  header?: BlockHeaderInfo | null
}

export interface VerifyMerkleProofResult {
  /** The BUMP parsed and commits to `txid` at its own `blockHeight`. */
  validBump: boolean
  /** The computed root equals the header's merkle root at that height. */
  rootMatchesHeader: boolean
  /**
   * True only when the header was chain-verified. Never true on proof
   * arithmetic alone.
   */
  spvVerified: boolean
  blockHeight?: number
  blockHash?: string
  merkleRoot?: string
  reason?: string
}

const TXID_RE = /^[0-9a-fA-F]{64}$/
const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/

/**
 * Parse and structurally validate a BUMP.
 *
 * Returns the parsed path or a reason. Kept separate from the network work so a
 * malformed proof costs no round trip.
 */
function parseBump(merklePathHex: string): { path: MerklePath } | { error: string } {
  const hex = String(merklePathHex ?? '').trim()
  if (!HEX_RE.test(hex)) {
    return { error: 'merklePathHex is not a valid hex string' }
  }
  let path: MerklePath
  try {
    path = MerklePath.fromHex(hex)
  } catch (error) {
    return {
      error: `merklePathHex is not a valid BRC-74 BUMP: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
  if (!Number.isSafeInteger(path.blockHeight) || path.blockHeight <= 0) {
    return { error: `BUMP carries an unusable block height (${path.blockHeight})` }
  }
  if (!Array.isArray(path.path) || path.path.length === 0) {
    return { error: 'BUMP has no levels' }
  }
  return { path }
}

/**
 * A single-leaf BUMP: one level, one leaf, and that leaf is the txid itself.
 *
 * Detected structurally rather than by comparing the root to the txid, because
 * a genuine one-transaction block produces exactly the same root. The point is
 * not that the shape is invalid but that it carries no independent evidence.
 */
function isSingleLeafSelfProof(path: MerklePath, txid: string): boolean {
  if (path.path.length !== 1) return false
  const level = path.path[0]
  if (!Array.isArray(level) || level.length !== 1) return false
  const leaf = level[0]
  if (!leaf) return false
  if (leaf.offset !== 0) return false
  if (typeof leaf.hash !== 'string') return false
  return leaf.hash.toLowerCase() === txid.toLowerCase()
}

/**
 * Verify a merkle proof.
 *
 * Never throws: every failure is reported in the result, because the callers
 * are background paths (SSE status handling, the reconciler) where an exception
 * would abort a whole batch over one bad proof.
 */
export async function verifyMerkleProof(
  input: VerifyMerkleProofInput,
): Promise<VerifyMerkleProofResult> {
  const txid = String(input?.txid ?? '').trim().toLowerCase()
  if (!TXID_RE.test(txid)) {
    return {
      validBump: false,
      rootMatchesHeader: false,
      spvVerified: false,
      reason: 'txid is not a 64-character hex transaction id',
    }
  }

  const parsed = parseBump(input.merklePathHex)
  if ('error' in parsed) {
    return { validBump: false, rootMatchesHeader: false, spvVerified: false, reason: parsed.error }
  }
  const path = parsed.path
  const height = path.blockHeight

  // A caller-claimed height that disagrees with the proof is a contradiction,
  // not a confirmation.
  if (
    input.claimedBlockHeight != null
    && Number.isSafeInteger(input.claimedBlockHeight)
    && input.claimedBlockHeight > 0
    && input.claimedBlockHeight !== height
  ) {
    return {
      validBump: false,
      rootMatchesHeader: false,
      spvVerified: false,
      blockHeight: height,
      reason:
        `BUMP is for block ${height} but the caller claims ${input.claimedBlockHeight}; ` +
        `refusing to treat contradictory evidence as confirmation`,
    }
  }

  let merkleRoot: string
  try {
    // `computeRoot` throws when `txid` is not a leaf of the tree, which is what
    // stops a proof belonging to a different transaction from being replayed.
    merkleRoot = String(path.computeRoot(txid)).toLowerCase()
  } catch (error) {
    return {
      validBump: false,
      rootMatchesHeader: false,
      spvVerified: false,
      blockHeight: height,
      reason: `BUMP does not commit to ${txid.slice(0, 16)}…: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  if (!TXID_RE.test(merkleRoot)) {
    return {
      validBump: false,
      rootMatchesHeader: false,
      spvVerified: false,
      blockHeight: height,
      reason: `BUMP computed an unusable root (${merkleRoot.slice(0, 32)})`,
    }
  }

  const singleLeaf = isSingleLeafSelfProof(path, txid)

  // Fetch the header. Without it there is nothing to compare the root against,
  // so the proof is arithmetically valid and nothing more.
  let header: BlockHeaderInfo | null = input.header ?? null
  if (!header) {
    try {
      header = await getHeaderByHeight(height)
    } catch (error) {
      return {
        validBump: true,
        rootMatchesHeader: false,
        spvVerified: false,
        blockHeight: height,
        merkleRoot,
        reason: `header ${height} is unreachable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }

  if (!header) {
    return {
      validBump: true,
      rootMatchesHeader: false,
      spvVerified: false,
      blockHeight: height,
      merkleRoot,
      reason: `no header available at height ${height}`,
    }
  }

  if (header.height !== height) {
    return {
      validBump: true,
      rootMatchesHeader: false,
      spvVerified: false,
      blockHeight: height,
      merkleRoot,
      blockHash: header.hash,
      reason: `header fetched at height ${height} reports height ${header.height}`,
    }
  }

  if (
    input.claimedBlockHash != null
    && String(input.claimedBlockHash).trim() !== ''
    && String(input.claimedBlockHash).trim().toLowerCase() !== header.hash
  ) {
    return {
      validBump: true,
      rootMatchesHeader: false,
      spvVerified: false,
      blockHeight: height,
      blockHash: header.hash,
      merkleRoot,
      reason:
        `the caller claims block ${String(input.claimedBlockHash).slice(0, 16)}… but height ` +
        `${height} is ${header.hash.slice(0, 16)}…`,
    }
  }

  if (header.merkleRoot !== merkleRoot) {
    return {
      validBump: true,
      rootMatchesHeader: false,
      spvVerified: false,
      blockHeight: height,
      blockHash: header.hash,
      merkleRoot,
      reason:
        `proof root ${merkleRoot.slice(0, 16)}… does not match header ${height}'s merkle root ` +
        `${header.merkleRoot.slice(0, 16)}…`,
    }
  }

  // Root equality established. Whether that is *evidence* depends on the
  // header, so the chain check is what decides `spvVerified`.
  const selfHosted = isSelfHostedChaintracks()
  const alreadyVerified = isLocallyVerified(height)

  if (singleLeaf && !alreadyVerified) {
    // Do not spend network work proving a header for a proof that cannot, by
    // itself, distinguish a real one-transaction block from a forgery: the
    // result would still be `spvVerified: false`.
    return {
      validBump: true,
      rootMatchesHeader: true,
      spvVerified: false,
      blockHeight: height,
      blockHash: header.hash,
      merkleRoot,
      reason:
        'single-leaf BUMP commits to the txid as its own root; that shape is also what a ' +
        'forged proof looks like, so it is not SPV evidence on its own',
    }
  }

  if (alreadyVerified || selfHosted) {
    // Either this header already passed the linkage proof, or it came from the
    // operator's own Chaintracks. For a self-hosted source, establish the
    // linkage now so the record is not merely "the operator said so".
    if (!alreadyVerified) {
      const proof = await verifyHeaderAgainstParent(header)
      if (!proof.linked || !proof.workValid || !proof.parentVerified) {
        return {
          validBump: true,
          rootMatchesHeader: true,
          spvVerified: false,
          blockHeight: height,
          blockHash: header.hash,
          merkleRoot,
          reason: proof.reason ?? 'header could not be linked to its parent',
        }
      }
    }
    return {
      validBump: true,
      rootMatchesHeader: true,
      spvVerified: true,
      blockHeight: height,
      blockHash: header.hash,
      merkleRoot,
    }
  }

  // Public host, not yet proven: prove the header now. This costs one extra
  // request per distinct block height, and the result is cached, so the cost
  // amortises across every transaction mined in the same block.
  const proof = await verifyHeaderAgainstParent(header)
  if (!proof.linked || !proof.workValid || !proof.parentVerified) {
    return {
      validBump: true,
      rootMatchesHeader: true,
      spvVerified: false,
      blockHeight: height,
      blockHash: header.hash,
      merkleRoot,
      reason: proof.reason ?? 'header could not be linked to its parent',
    }
  }

  return {
    validBump: true,
    rootMatchesHeader: true,
    spvVerified: true,
    blockHeight: height,
    blockHash: header.hash,
    merkleRoot,
  }
}

/**
 * Structural check only: does this BUMP commit to this txid, and is it more
 * than a self-referential leaf?
 *
 * For callers that must decide synchronously (for example whether to accept an
 * overlay submission at all) and cannot afford a header fetch.
 */
export function isBumpStructurallyCredible(txid: string, merklePathHex: string): boolean {
  const normalised = String(txid ?? '').trim().toLowerCase()
  if (!TXID_RE.test(normalised)) return false
  const parsed = parseBump(merklePathHex)
  if ('error' in parsed) return false
  if (isSingleLeafSelfProof(parsed.path, normalised)) return false
  try {
    const root = String(parsed.path.computeRoot(normalised)).toLowerCase()
    return TXID_RE.test(root) && root !== normalised
  } catch {
    return false
  }
}
