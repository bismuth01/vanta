// Shared by firms (sealing) and the enclave (opening): what a sealed strategy is.
import { encodeAbiParameters, keccak256, type Hex } from 'viem'

export type StrategyPayload = {
  firmName: string
  label: string // human description, e.g. "Sliced stop-loss @ 2.88"
  contract: string // which IStrategy implementation (for display only)
  code: Hex // runtime bytecode of an IStrategy implementation
  initState: Hex // abi-encoded parameters = private initial state
}

/// Commitment registered on-chain. It binds the exact code + parameters without revealing them.
export function commitment(code: Hex, initState: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [code, initState]))
}

export const encodePayload = (p: StrategyPayload) => Buffer.from(JSON.stringify(p))
export const decodePayload = (b: Buffer) => JSON.parse(b.toString('utf8')) as StrategyPayload

/// DarkPool.strategyIdOf(firm, commitment): ids are bound to the registering firm.
export function strategyIdOf(firm: Hex, c: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [firm, c]))
}
