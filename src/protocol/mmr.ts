import { concat, hexToBytes, keccak256, type Hex } from "viem";

// Port of solana/programs/bridge/src/base_to_solana/internal/mmr.rs. The browser checks every proof
// against the on-chain output root before asking the user to sign, so a bad proof never costs fees.

type Mountain = { height: number; containsLeaf: boolean };

function mountainsFor(leafIndex: bigint, totalLeafCount: bigint): { mountains: Mountain[]; leafHeight: number } {
  if (totalLeafCount <= 0n) throw new Error("The MMR is empty.");
  if (leafIndex >= totalLeafCount) throw new Error("The leaf is not covered by this output root yet.");

  const mountains: Mountain[] = [];
  let remaining = totalLeafCount;
  let offset = 0n;
  let leafHeight = -1;
  for (let height = totalLeafCount.toString(2).length - 1; height >= 0 && remaining > 0n; height--) {
    const size = 1n << BigInt(height);
    if ((remaining & size) === 0n) continue;
    const containsLeaf = leafIndex >= offset && leafIndex < offset + size;
    mountains.push({ height, containsLeaf });
    if (containsLeaf) leafHeight = height;
    offset += size;
    remaining -= size;
  }
  if (leafHeight < 0) throw new Error("The leaf's mountain was not found.");
  return { mountains, leafHeight };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function commutativeHash(a: Hex, b: Hex): Hex {
  return compareBytes(hexToBytes(a), hexToBytes(b)) < 0 ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export function mmrRootFromProof(proof: readonly Hex[], leafHash: Hex, leafIndex: bigint, totalLeafCount: bigint): Hex {
  const { mountains, leafHeight } = mountainsFor(leafIndex, totalLeafCount);
  if (proof.length < leafHeight) throw new Error("The proof has too few nodes for the leaf's mountain.");

  let cursor = 0;
  let peak = leafHash;
  for (let i = 0; i < leafHeight; i++) peak = commutativeHash(peak, proof[cursor++]);

  const peaks: Hex[] = [];
  for (const mountain of mountains) {
    if (mountain.containsLeaf) peaks.push(peak);
    else {
      if (cursor >= proof.length) throw new Error("The proof has too few peak nodes.");
      peaks.push(proof[cursor++]);
    }
  }
  if (cursor !== proof.length) throw new Error("The proof has unused nodes.");

  return peaks.slice(1).reduce<Hex>((root, next) => keccak256(concat([root, next])), peaks[0]);
}

export function verifyMmrProof(input: {
  root: Hex;
  leafHash: Hex;
  leafIndex: bigint;
  proof: readonly Hex[];
  totalLeafCount: bigint;
}): boolean {
  try {
    return mmrRootFromProof(input.proof, input.leafHash, input.leafIndex, input.totalLeafCount).toLowerCase() === input.root.toLowerCase();
  } catch {
    return false;
  }
}
