/**
 * Transaction construction for the BSV Broadcaster path.
 *
 * Every builder here produces three artefacts from one signed transaction:
 *
 *   - `rawHex`  — the classic serialization, for ARC / WoC / explorer fallbacks
 *   - `efBytes` — BRC-30 Extended Format, the only payload the BSV Broadcaster
 *                 accepts for validator-grade fee and script checks
 *   - `txid`    — the double-SHA256 id, so a caller can reject a broadcaster
 *                 that echoes back a different transaction
 *
 * ## Why the source transaction is attached after signing
 *
 * `Transaction.toEFUint8Array()` requires `input.sourceTransaction` on every
 * input, but it reads only two fields from it: `outputs[vout].satoshis` and
 * `outputs[vout].lockingScript` (`@bsv/sdk@2.8.11`,
 * `dist/esm/src/transaction/Transaction.js:921-974`). It never serialises the
 * parent's body.
 *
 * Attaching a lightweight stand-in *before* signing fails: `P2PKH.unlock()`
 * calls `resolveSourceDetails`, which compares `sourceTXID` against
 * `sourceTransaction.id('hex')`. A stand-in has no real inputs, so its id is
 * the hash of an empty transaction and never matches the claimed outpoint. The
 * SDK throws "The input sourceTXID does not match the input sourceTransaction".
 *
 * So signing passes the amount and locking script explicitly
 * (`unlock(key, 'all', false, satoshis, lockingScript)`) — which is what the
 * preimage needs anyway — and the stand-in is attached immediately afterwards,
 * purely to satisfy EF serialisation. The signature commits to the same
 * sourceTXID either way, and `rawHex` hashes to the same txid before and after
 * attachment because the plain serialisation reads `sourceTXID`, not the
 * source transaction.
 *
 * ## Fees
 *
 * Fee is a satoshi amount, never a rate applied at broadcast time. Callers get
 * a deterministic fee they can log and reconcile. When `explicitFeeSats` is
 * omitted the builder computes the fee from the *actual signed size*, at
 * `BSV_TX_FEE_RATE_SAT_PER_BYTE` (default `DEFAULT_TX_FEE_RATE`). It signs
 * first, measures, and re-signs only if the measured size needs a higher fee,
 * so variance in DER signature length (70-72 bytes) cannot leave the
 * transaction one satoshi under a policy floor.
 *
 * No network call is made in this module: it is safe to unit test and safe to
 * call from a worker mid-cycle.
 */

import { LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { DEFAULT_TX_FEE_RATE } from '../bsv-config'

/** One spendable outpoint. */
export interface TxInputSpec {
  txid: string
  vout: number
  satoshis: number
  /** Hex of the output being spent. Must pay the WIF's P2PKH address. */
  lockingScriptHex: string
  /**
   * Optional raw hex of the parent transaction. When present it is parsed and
   * cross-checked against `txid`, `satoshis` and `lockingScriptHex`: a mismatch
   * throws rather than signing against a claimed outpoint nobody verified.
   */
  rawTxHex?: string
}

export interface BuiltTransactionOutput {
  vout: number
  satoshis: number
  outputScript: string
  isChange: boolean
}

export interface BuiltTransaction {
  tx: Transaction
  txid: string
  rawHex: string
  efBytes: Uint8Array
  efHex: string
  feeSats: number
  sizeBytes: number
  outputs: BuiltTransactionOutput[]
}

/** Raised when inputs cannot cover outputs plus fee. */
export class InsufficientFundsError extends Error {
  constructor(
    message: string,
    readonly detail: { inputSats: number; outputSats: number; feeSats: number },
  ) {
    super(message)
    this.name = 'InsufficientFundsError'
  }
}

/**
 * Worst-case signed P2PKH input: 32 txid + 4 vout + 1 script-length + 108
 * unlocking script + 4 sequence. Used only for the first fee guess, before a
 * real signature exists to measure.
 */
const ESTIMATED_SIGNED_P2PKH_INPUT_BYTES = 149
/** A P2PKH output is always 8 + 1 + 25 bytes. */
const P2PKH_OUTPUT_BYTES = 34
/** version (4) + input count (1) + output count (1) + locktime (4). */
const TX_ENVELOPE_BYTES = 10
/** How many times the builder will re-sign to correct a fee from a measured size. */
const MAX_FEE_PASSES = 3

const TXID_RE = /^[0-9a-fA-F]{64}$/
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/

function localFeeRateSatPerByte(): number {
  const raw = process.env.BSV_TX_FEE_RATE_SAT_PER_BYTE ?? process.env.BSV_TX_FEE_RATE
  const parsed = Number.parseFloat(String(raw ?? '').trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TX_FEE_RATE
}

function assertTxid(txid: unknown, label: string): string {
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) {
    throw new Error(`${label} must be a 64-character hex transaction id`)
  }
  return txid.toLowerCase()
}

function assertLockingScriptHex(hex: unknown, label: string): string {
  if (typeof hex !== 'string' || !HEX_RE.test(hex) || hex.length === 0) {
    throw new Error(`${label} must be a non-empty even-length hex locking script`)
  }
  return hex.toLowerCase()
}

function assertSatoshis(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of satoshis`)
  }
  if (value > 21e14) {
    throw new Error(`${label} exceeds the maximum BSV money supply`)
  }
  return value
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** The P2PKH locking script hex that `wif` can spend. */
export function p2pkhLockingScriptHexFromWif(wif: string): string {
  const key = PrivateKey.fromWif(String(wif ?? '').trim())
  return new P2PKH().lock(key.toPublicKey().toAddress()).toHex().toLowerCase()
}

/** The mainnet P2PKH address for `wif`. */
export function addressFromWif(wif: string): string {
  const key = PrivateKey.fromWif(String(wif ?? '').trim())
  return key.toPublicKey().toAddress()
}

/**
 * A stand-in source transaction carrying only the claimed output.
 *
 * Indices below `vout` are filled with an empty, zero-value output rather than
 * left as holes: a sparse array is serialised inconsistently and any consumer
 * that iterates `outputs` would read `undefined`. The SDK's own `fromEF` builds
 * the same shape (`Transaction.js:286-291`).
 */
function buildSourcePlaceholder(vout: number, satoshis: number, lockingScriptHex: string): Transaction {
  const source = new Transaction(undefined, [], [], undefined)
  const empty: { satoshis: number; lockingScript: LockingScript } = {
    satoshis: 0,
    lockingScript: new LockingScript([]),
  }
  const outputs: Array<{ satoshis: number; lockingScript: LockingScript }> = []
  for (let i = 0; i < vout; i++) outputs.push(empty)
  outputs.push({ satoshis, lockingScript: LockingScript.fromHex(lockingScriptHex) })
  source.outputs = outputs
  return source
}

interface ResolvedInput {
  txid: string
  vout: number
  satoshis: number
  lockingScriptHex: string
  /** Parsed real parent, when the caller supplied rawTxHex. */
  rawTx?: Transaction
}

function resolveInput(input: TxInputSpec, expectedLockingScriptHex: string, index: number): ResolvedInput {
  const txid = assertTxid(input?.txid, `inputs[${index}].txid`)
  const vout = assertSatoshis(input?.vout, `inputs[${index}].vout`)
  const satoshis = assertSatoshis(input?.satoshis, `inputs[${index}].satoshis`)
  const lockingScriptHex = assertLockingScriptHex(
    input?.lockingScriptHex,
    `inputs[${index}].lockingScriptHex`,
  )

  if (lockingScriptHex !== expectedLockingScriptHex) {
    throw new Error(
      `inputs[${index}] (${txid.slice(0, 12)}…:${vout}) does not pay this WIF's P2PKH address; ` +
        `refusing to sign a transaction the network will reject`,
    )
  }

  let rawTx: Transaction | undefined
  if (input.rawTxHex != null) {
    const rawHex = String(input.rawTxHex).trim()
    if (!HEX_RE.test(rawHex) || rawHex.length === 0) {
      throw new Error(`inputs[${index}].rawTxHex is not valid hex`)
    }
    rawTx = Transaction.fromHex(rawHex)
    const actualTxid = String(rawTx.id('hex')).toLowerCase()
    if (actualTxid !== txid) {
      throw new Error(
        `inputs[${index}].rawTxHex hashes to ${actualTxid.slice(0, 12)}… but the input claims ` +
          `${txid.slice(0, 12)}…; refusing to sign an unverified outpoint`,
      )
    }
    const output = rawTx.outputs[vout]
    if (!output) {
      throw new Error(`inputs[${index}].rawTxHex has no output at index ${vout}`)
    }
    if (output.satoshis !== satoshis) {
      throw new Error(
        `inputs[${index}] claims ${satoshis} sats but its parent pays ${output.satoshis}; ` +
          `signing the wrong amount produces an invalid signature`,
      )
    }
    const actualScript = output.lockingScript.toHex().toLowerCase()
    if (actualScript !== lockingScriptHex) {
      throw new Error(
        `inputs[${index}] lockingScriptHex does not match its parent output; refusing to sign`,
      )
    }
  }

  return { txid, vout, satoshis, lockingScriptHex, rawTx }
}

interface OutputSpec {
  satoshis: number
  /** Literal script hex. Takes precedence over `address` when both are given. */
  lockingScriptHex?: string
  /** Address form, used to build the script when `lockingScriptHex` is absent. */
  address?: string
  isChange?: boolean
}

interface BuildCoreInput {
  wif: string
  inputs: TxInputSpec[]
  outputs: OutputSpec[]
  /** Where change goes. When absent, change is not emitted at all. */
  changeAddress?: string
  /** Pay exactly this fee. When absent the fee is derived from the signed size. */
  explicitFeeSats?: number
  /** Also send the sub-floor remainder to fee instead of stranding it. */
  emitChange: boolean
  /** Change below this is not worth creating; it is added to the fee instead. */
  changeFloorSats?: number
}

function estimateInitialSize(inputCount: number, outputScriptByteLengths: number[]): number {
  let size = TX_ENVELOPE_BYTES + inputCount * ESTIMATED_SIGNED_P2PKH_INPUT_BYTES
  for (const bytes of outputScriptByteLengths) {
    size += 8 + (bytes < 253 ? 1 : 3) + bytes
  }
  return size
}

/**
 * Build, sign and serialise in every supported format.
 *
 * Change handling is the one place a builder can quietly waste money. A change
 * output below the floor a caller can ever spend again is a permanent loss: it
 * is too small to acquire, so it can only be swept, and sweeping it costs a
 * fee. `emitChange` combined with `changeFloorSats` makes that explicit — the
 * remainder goes to the fee (which is a *lower* loss than a stranded output)
 * rather than being emitted as dust.
 */
async function buildCore(spec: BuildCoreInput): Promise<BuiltTransaction> {
  const wif = String(spec.wif ?? '').trim()
  if (!wif) throw new Error('wif is required')

  const privateKey = PrivateKey.fromWif(wif)
  const ownAddress = privateKey.toPublicKey().toAddress()
  const ownLockingScriptHex = new P2PKH().lock(ownAddress).toHex().toLowerCase()

  if (!Array.isArray(spec.inputs) || spec.inputs.length === 0) {
    throw new Error('at least one input is required')
  }
  if (!Array.isArray(spec.outputs) || spec.outputs.length === 0) {
    throw new Error('at least one output is required')
  }

  const inputs = spec.inputs.map((input, index) => resolveInput(input, ownLockingScriptHex, index))
  const inputSats = inputs.reduce((sum, input) => sum + input.satoshis, 0)

  const requestedOutputs: Array<{ satoshis: number; lockingScript: LockingScript }> = []
  for (let index = 0; index < spec.outputs.length; index++) {
    const output = spec.outputs[index]
    const satoshis = assertSatoshis(output.satoshis, `outputs[${index}].satoshis`)
    let lockingScript: LockingScript
    if (output.lockingScriptHex != null) {
      lockingScript = LockingScript.fromHex(
        assertLockingScriptHex(output.lockingScriptHex, `outputs[${index}].lockingScriptHex`),
      )
    } else if (output.address != null) {
      lockingScript = new P2PKH().lock(String(output.address).trim())
    } else {
      throw new Error(`outputs[${index}] needs either lockingScriptHex or address`)
    }
    requestedOutputs.push({ satoshis, lockingScript })
  }

  const requestedOutputSats = requestedOutputs.reduce((sum, output) => sum + output.satoshis, 0)
  const changeScript = spec.changeAddress
    ? new P2PKH().lock(String(spec.changeAddress).trim())
    : null

  const outputScriptBytes = requestedOutputs.map(
    (output) => output.lockingScript.toUint8Array().length,
  )
  const changeBytes = changeScript ? changeScript.toUint8Array().length : 0

  const feeRate = localFeeRateSatPerByte()
  const changeFloor = Math.max(1, spec.changeFloorSats ?? 1)
  const hasExplicitFee = typeof spec.explicitFeeSats === 'number'

  let feeSats = hasExplicitFee
    ? assertSatoshis(spec.explicitFeeSats, 'explicitFeeSats')
    : Math.ceil(
        estimateInitialSize(inputs.length, changeScript ? [...outputScriptBytes, changeBytes] : outputScriptBytes) *
          feeRate,
      )

  let built: { tx: Transaction; rawHex: string; changeValue: number; actualFee: number } | null = null
  let lastError: Error | null = null

  for (let pass = 0; pass < MAX_FEE_PASSES; pass++) {
    const fee = feeSats
    const remaining = inputSats - requestedOutputSats - fee

    if (remaining < 0) {
      throw new InsufficientFundsError(
        `inputs (${inputSats} sats) cannot cover outputs (${requestedOutputSats} sats) plus a ` +
          `${fee}-sat fee`,
        { inputSats, outputSats: requestedOutputSats, feeSats: fee },
      )
    }

    const spendChange = changeScript != null && spec.emitChange && remaining >= changeFloor
    // Anything not emitted as change is paid as fee. That is deliberate: a
    // 3-sat change output is unspendable and would strand sats forever.
    const actualFee = spendChange ? fee : fee + remaining
    const changeValue = spendChange ? remaining : 0

    const tx = new Transaction()
    tx.version = 2
    for (const input of inputs) {
      tx.addInput({
        sourceTXID: input.txid,
        sourceOutputIndex: input.vout,
        // Amount and script are passed explicitly because the stand-in source
        // is attached only after signing (see the module comment).
        unlockingScriptTemplate: new P2PKH().unlock(
          privateKey,
          'all',
          false,
          input.satoshis,
          LockingScript.fromHex(input.lockingScriptHex),
        ),
      })
    }
    for (const output of requestedOutputs) {
      tx.addOutput({ satoshis: output.satoshis, lockingScript: output.lockingScript })
    }
    if (spendChange && changeScript) {
      tx.addOutput({ satoshis: changeValue, lockingScript: changeScript, change: true })
    }

    try {
      await tx.sign()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      // A signature-length change cannot fix a signing failure; stop.
      break
    }

    // Attach the EF stand-ins now that the signatures exist.
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index]
      tx.inputs[index].sourceTransaction = buildSourcePlaceholder(
        input.vout,
        input.satoshis,
        input.lockingScriptHex,
      )
    }

    const rawHex = tx.toHex()
    built = { tx, rawHex, changeValue, actualFee }

    if (hasExplicitFee) break

    const signedSize = rawHex.length / 2
    const requiredFee = Math.ceil(signedSize * feeRate)
    // The requested output set is fixed, so a larger fee only shrinks the change
    // output — whose size is constant. One correction pass therefore settles.
    if (actualFee >= requiredFee) break
    if (!spendChange) {
      // No change output to shrink from: the fee is already the whole
      // remainder, so the caller simply cannot afford this transaction.
      throw new InsufficientFundsError(
        `signed transaction is ${signedSize} bytes and needs a ${requiredFee}-sat fee, but only ` +
          `${actualFee} sats remain after the outputs`,
        { inputSats, outputSats: requestedOutputSats, feeSats: actualFee },
      )
    }
    feeSats = requiredFee
  }

  if (!built) {
    throw new Error(`transaction signing failed: ${lastError?.message ?? 'unknown error'}`)
  }

  const efBytes = built.tx.toEFUint8Array()
  const txid = String(built.tx.id('hex')).toLowerCase()

  // Guard the EF round-trip at the point of construction: a payload that cannot
  // be re-parsed by the same SDK is a payload the broadcaster cannot validate,
  // and discovering that at submit time wastes a broadcast attempt.
  const reparsed = Transaction.fromEF(efBytes)
  if (String(reparsed.id('hex')).toLowerCase() !== txid) {
    throw new Error(
      `EF round-trip changed the transaction id (${txid.slice(0, 12)}… → ` +
        `${String(reparsed.id('hex')).slice(0, 12)}…); refusing to return an unverifiable payload`,
    )
  }

  const outputs: BuiltTransactionOutput[] = built.tx.outputs.map((output, vout) => ({
    vout,
    satoshis: output.satoshis ?? 0,
    outputScript: output.lockingScript.toHex().toLowerCase(),
    isChange: output.change === true,
  }))

  return {
    tx: built.tx,
    txid,
    rawHex: built.rawHex,
    efBytes,
    efHex: bytesToHex(efBytes),
    feeSats: built.actualFee,
    sizeBytes: built.rawHex.length / 2,
    outputs,
  }
}

/**
 * One OP_RETURN output plus optional change.
 *
 * `opReturnScriptHex` is passed as hex rather than assembled here so the exact
 * bytes that were hashed, validated and logged are the bytes that get signed.
 *
 * `changeFloorSats` is the same rule the production write path uses: a change
 * output below the smallest amount a later write can acquire (and therefore
 * spend) can never be used. Emitting it strands those sats permanently — the
 * row exists but no acquisition will ever pick it — whereas adding it to the
 * fee loses strictly less. Defaults to 1, which means "emit any change".
 */
export async function buildOpReturnTx(input: {
  wif: string
  inputs: TxInputSpec[]
  opReturnScriptHex: string
  opReturnSats: number
  changeAddress: string
  explicitFeeSats?: number
  emitChange?: boolean
  changeFloorSats?: number
}): Promise<BuiltTransaction> {
  return buildCore({
    wif: input.wif,
    inputs: input.inputs,
    outputs: [
      {
        satoshis: assertSatoshis(input.opReturnSats, 'opReturnSats'),
        lockingScriptHex: assertLockingScriptHex(input.opReturnScriptHex, 'opReturnScriptHex'),
      },
    ],
    changeAddress: input.changeAddress,
    explicitFeeSats: input.explicitFeeSats,
    emitChange: input.emitChange !== false,
    changeFloorSats: input.changeFloorSats,
  })
}

/**
 * Fan one outpoint into `outputCount` equal outputs back to the same address.
 *
 * Change returns to the signing key, not to `destinationAddress`: a split moves
 * value between outputs of one wallet, so the leftover must stay spendable by
 * the key that signed.
 */
export async function buildSplitTx(input: {
  wif: string
  input: TxInputSpec
  destinationAddress: string
  outputCount: number
  outputSats: number
  explicitFeeSats?: number
}): Promise<BuiltTransaction> {
  const outputCount = assertPositiveInt(input.outputCount, 'outputCount')
  const outputSats = assertSatoshis(input.outputSats, 'outputSats')
  if (outputSats < 1) {
    throw new Error('outputSats must be at least 1 satoshi')
  }
  const destinationAddress = String(input.destinationAddress ?? '').trim()
  if (!destinationAddress) throw new Error('destinationAddress is required')

  const outputs: OutputSpec[] = Array.from({ length: outputCount }, () => ({
    satoshis: outputSats,
    address: destinationAddress,
    lockingScriptHex: undefined,
  }))

  return buildCore({
    wif: input.wif,
    inputs: [input.input],
    outputs,
    changeAddress: addressFromWif(input.wif),
    explicitFeeSats: input.explicitFeeSats,
    // Below this, an output cannot be spent by a later write; the remainder
    // belongs in change so consolidation can pick it up.
    emitChange: true,
    changeFloorSats: 1,
  })
}

/** Sweep several outpoints into one output at `destinationAddress`. */
export async function buildConsolidationTx(input: {
  wif: string
  inputs: TxInputSpec[]
  destinationAddress: string
  explicitFeeSats?: number
}): Promise<BuiltTransaction> {
  const destinationAddress = String(input.destinationAddress ?? '').trim()
  if (!destinationAddress) throw new Error('destinationAddress is required')

  const totalIn = input.inputs.reduce((sum, spec) => {
    return sum + assertSatoshis(spec?.satoshis, 'inputs[].satoshis')
  }, 0)

  const fee = typeof input.explicitFeeSats === 'number'
    ? assertSatoshis(input.explicitFeeSats, 'explicitFeeSats')
    : Math.ceil(
        estimateInitialSize(input.inputs.length, [P2PKH_OUTPUT_BYTES]) * localFeeRateSatPerByte(),
      )

  // A consolidation has exactly one output: everything the inputs hold, minus
  // the fee. There is deliberately no change output — a consolidation that
  // left change behind would have consolidated nothing.
  const swept = totalIn - fee
  if (swept < 1) {
    throw new InsufficientFundsError(
      `inputs (${totalIn} sats) cannot cover a ${fee}-sat fee and leave an output`,
      { inputSats: totalIn, outputSats: 0, feeSats: fee },
    )
  }
  return buildCore({
    wif: input.wif,
    inputs: input.inputs,
    outputs: [{ satoshis: swept, address: destinationAddress }],
    explicitFeeSats: input.explicitFeeSats,
    emitChange: false,
  })
}

/** Pay one or more addresses, returning leftover value to `changeAddress`. */
export async function buildPaymentTx(input: {
  wif: string
  inputs: TxInputSpec[]
  outputs: Array<{ address: string; satoshis: number }>
  changeAddress: string
  explicitFeeSats?: number
  /** See `buildOpReturnTx`. Defaults to 1 (emit any change). */
  changeFloorSats?: number
}): Promise<BuiltTransaction> {
  if (!Array.isArray(input.outputs) || input.outputs.length === 0) {
    throw new Error('at least one payment output is required')
  }
  const outputs: OutputSpec[] = input.outputs.map((output, index) => {
    const address = String(output?.address ?? '').trim()
    if (!address) throw new Error(`outputs[${index}].address is required`)
    return {
      satoshis: assertSatoshis(output.satoshis, `outputs[${index}].satoshis`),
      address,
    }
  })

  return buildCore({
    wif: input.wif,
    inputs: input.inputs,
    outputs,
    changeAddress: input.changeAddress,
    explicitFeeSats: input.explicitFeeSats,
    emitChange: true,
    changeFloorSats: input.changeFloorSats,
  })
}

/**
 * Parse a signed raw transaction back into its EF payload.
 *
 * Used by the fallback path in `lib/broadcast-raw-tx.ts`, which has only a raw
 * hex string from a legacy caller and needs an EF body for the Broadcaster.
 * Every input must carry a source transaction, which a raw transaction parsed
 * from hex does not have — so this returns `null` rather than guessing amounts.
 */
export function efFromRawHexWithPrevouts(
  rawHex: string,
  prevouts: Array<{ lockingScript: string; satoshis: number }>,
): Uint8Array | null {
  try {
    const tx = Transaction.fromHex(rawHex)
    if (tx.inputs.length !== prevouts.length) return null
    for (let index = 0; index < tx.inputs.length; index++) {
      const prevout = prevouts[index]
      const satoshis = assertSatoshis(prevout?.satoshis, `prevouts[${index}].satoshis`)
      const lockingScriptHex = assertLockingScriptHex(
        prevout?.lockingScript,
        `prevouts[${index}].lockingScript`,
      )
      tx.inputs[index].sourceTransaction = buildSourcePlaceholder(
        tx.inputs[index].sourceOutputIndex,
        satoshis,
        lockingScriptHex,
      )
    }
    return tx.toEFUint8Array()
  } catch {
    return null
  }
}

export { hexToBytes, bytesToHex }
