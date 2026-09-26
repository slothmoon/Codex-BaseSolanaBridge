import { getAddress, type PublicClient } from "viem";

import { NETWORK } from "../config";
import { bytesToAddress } from "../protocol/bytes";
import { readImplementation } from "./base";
import { fetchAccounts, type SolanaRpc } from "./solana";

/**
 * The Base contracts and the Solana program are all upgradeable. This compares what is deployed
 * today with what this interface was verified against, so users are told when that is no longer true.
 */
export async function findUpgradedComponents(base: PublicClient, rpc: SolanaRpc): Promise<string[]> {
  const pins = NETWORK.pins;
  if (!pins) return [];
  const changed: string[] = [];

  const [bridgeImpl, factoryImpl] = await Promise.all([readImplementation(base, NETWORK.base.bridge), readImplementation(base, NETWORK.base.factory)]);
  if (bridgeImpl !== getAddress(pins.baseBridgeImplementation)) changed.push("Base bridge contract");
  if (factoryImpl !== getAddress(pins.baseFactoryImplementation)) changed.push("Base token factory");

  const [program] = await fetchAccounts(rpc, [NETWORK.solana.bridgeProgram]);
  if (program && program.data.length >= 36) {
    const programData = bytesToAddress(program.data.subarray(4, 36));
    const { value } = await rpc
      .getAccountInfo(programData, { encoding: "base64", dataSlice: { offset: 0, length: 12 }, commitment: "confirmed" })
      .send();
    if (value) {
      const header = Uint8Array.from(atob((value.data as unknown as [string, string])[0]), (c) => c.charCodeAt(0));
      const deploySlot = new DataView(header.buffer).getBigUint64(4, true);
      if (deploySlot !== pins.solanaProgramDeploySlot) changed.push("Solana bridge program");
    }
  }
  return changed;
}
