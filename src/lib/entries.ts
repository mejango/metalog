import { decodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { Coefficients } from '../domain/distribution'
import { decodeEntryMemo, NATIVE_TOKEN, projectNumber, quantitiesOf, receiptMoves, verifyRecordedEntry, type MarketSnapshot } from './defifa'
import { assertChain, DEFIFA_ABI, deploymentForChain, sameAddress } from './defifa-deployment'

export type EntryHistoryEntry = {
  status: 'verified-curve' | 'verified-manual' | 'unrecognized' | 'unsupported' | 'invalid'
  transactionHash: Hex
  blockNumber: string
  timestamp: number
  account: Address
  beneficiary: Address | null
  stakeWei: string | null
  quantities: number[]
  coefficients: Coefficients | null
  reason?: string
}
const MAX_LOGS = 2_000

function receiptMints(market: MarketSnapshot, receipt: Pick<TransactionReceipt, 'logs'>) {
  return receiptMoves(market.hook, receipt).filter(move => sameAddress(move.from, zeroAddress))
}

type MintLog = { transactionHash: Hex; blockNumber: bigint; blockHash: Hex; transactionIndex: number }

/** Checks one transaction that minted positions in this market and returns its entry evidence. */
async function verifyEntryTransaction(client: PublicClient, market: MarketSnapshot, log: MintLog): Promise<EntryHistoryEntry> {
  const d = deploymentForChain(market.chainId)
  const [receipt, transaction, block] = await Promise.all([
    client.getTransactionReceipt({ hash: log.transactionHash }), client.getTransaction({ hash: log.transactionHash }),
    client.getBlock({ blockNumber: log.blockNumber }),
  ])
  if (receipt.status !== 'success' || receipt.blockNumber !== log.blockNumber || receipt.blockHash !== log.blockHash
    || block.number !== log.blockNumber || block.hash !== log.blockHash || transaction.hash !== log.transactionHash || receipt.transactionHash !== log.transactionHash
    || transaction.blockHash !== block.hash || transaction.blockNumber !== block.number || transaction.transactionIndex !== log.transactionIndex
    || receipt.transactionIndex !== log.transactionIndex || !sameAddress(receipt.from, transaction.from)
    || receipt.to?.toLowerCase() !== transaction.to?.toLowerCase()) {
    throw new Error('The entry receipt is not canonical for this snapshot.')
  }
  const timestamp = Number(block.timestamp)
  if (timestamp < market.definition.entryOpensAt || timestamp >= market.definition.entryClosesAt) {
    throw new Error('The entry receipt falls outside the entry period.')
  }
  const mints = receiptMints(market, receipt)
  if (!mints.length || mints.length > MAX_LOGS) throw new Error('The entry receipt does not prove its discovered mint.')
  const quantities = quantitiesOf(market, mints)
  const minted = mints.reduce((sum, mint) => sum + mint.value, 0n)
  const entry: EntryHistoryEntry = { status: 'unsupported', transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(), timestamp, account: transaction.from,
    beneficiary: mints.every(mint => sameAddress(mint.to, mints[0].to)) ? mints[0].to : null, stakeWei: null, quantities, coefficients: null }
  if (!sameAddress(transaction.to, d.terminal)) {
    entry.reason = 'Wrapped calls are not decoded. Mint effects are shown; outer transaction value is not an attributed entry stake.'
    return entry
  }
  let call: { functionName: string; args?: readonly unknown[] }
  try { call = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: transaction.input }) }
  catch { entry.reason = 'The terminal call is not a supported direct payment.'; return entry }
  if (call.functionName !== 'pay') { entry.reason = 'The terminal call is not a direct payment.'; return entry }
  const [id, token, amount, beneficiary, minimum, memoText, metadata] = call.args as readonly [bigint, Address, bigint, Address, bigint, string, Hex]
  if (id !== projectNumber(market.projectId) || !sameAddress(token, NATIVE_TOKEN) || amount !== transaction.value
    || minimum !== 0n || BigInt(quantities.reduce((sum, quantity) => sum + quantity, 0)) !== minted
    || mints.some(mint => !sameAddress(mint.to, beneficiary))) {
    entry.status = 'invalid'; entry.reason = 'The payment and minted positions do not match this market.'; return entry
  }
  entry.beneficiary = beneficiary
  entry.stakeWei = amount.toString()
  if (!sameAddress(beneficiary, transaction.from)) {
    entry.reason = 'Payments for another beneficiary are not supported as Metalog curve evidence.'; return entry
  }
  if (memoText.length > 1_024 || metadata.length > 14_000) {
    entry.reason = 'The entry memo or metadata exceeds the supported audit limit.'; return entry
  }
  let json: unknown
  try { json = JSON.parse(memoText) }
  catch { entry.status = 'unrecognized'; entry.reason = 'This entry has no recognized Metalog curve memo.'; return entry }
  const schema = json && typeof json === 'object' && 'schema' in json ? json.schema : null
  if (schema !== 'metalog.entry.v1' && schema !== 'metalog.entry.v2') {
    entry.status = 'unrecognized'; entry.reason = 'This entry has no recognized Metalog curve memo.'; return entry
  }
  try {
    const memo = decodeEntryMemo(memoText, metadata)
    const verified = verifyRecordedEntry(market, d.implementation, beneficiary, amount, memo, metadata, receipt)
    entry.coefficients = verified.coefficients
    entry.status = verified.allocation.mode === 'curve' ? 'verified-curve' : 'verified-manual'
  } catch {
    entry.status = 'invalid'; entry.reason = 'The recorded curve or manual allocation does not match the payment and minted positions.'
  }
  return entry
}

/** One entry by transaction: its receipt, payment and recorded curve, checked against the minted positions. */
export async function readEntry(client: PublicClient, market: MarketSnapshot, transactionHash: Hex): Promise<EntryHistoryEntry> {
  await assertChain(client, market.chainId)
  const receipt = await client.getTransactionReceipt({ hash: transactionHash })
  const mints = receiptMints(market, receipt)
  if (!mints.length || receipt.blockNumber > BigInt(market.blockNumber)) throw new Error('This transaction did not mint positions in this market.')
  return verifyEntryTransaction(client, market, { transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    transactionIndex: receipt.transactionIndex })
}

