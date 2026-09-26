import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/kit";
import { bytesToHex, hexToBytes, type Hex } from "viem";

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export function addressToBytes(value: Address): Uint8Array {
  return new Uint8Array(addressEncoder.encode(value));
}

export function bytesToAddress(bytes: Uint8Array): Address {
  if (bytes.length !== 32) throw new Error(`Expected 32 bytes for a Solana address, got ${bytes.length}.`);
  return addressDecoder.decode(bytes);
}

export function addressToBytes32Hex(value: Address): Hex {
  return bytesToHex(addressToBytes(value));
}

export function bytes32HexToAddress(value: Hex): Address {
  return bytesToAddress(hexToBytes(value));
}

export function concatBytes(...parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** Bounds-checked little-endian reader over account or message bytes. */
export class ByteReader {
  private readonly view: DataView;
  offset = 0;

  constructor(readonly bytes: Uint8Array, private readonly label = "data") {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private need(length: number): void {
    if (this.offset + length > this.bytes.length) {
      throw new Error(`The ${this.label} is shorter than expected.`);
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new Error(`The ${this.label} has an invalid boolean flag.`);
    return value === 1;
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    this.need(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bytes_(length: number): Uint8Array {
    this.need(length);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  address(): Address {
    return bytesToAddress(this.bytes_(32));
  }

  skip(length: number): void {
    this.need(length);
    this.offset += length;
  }
}

export function equalBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hasPrefix(data: ArrayLike<number>, prefix: ArrayLike<number>): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

export { bytesToHex, hexToBytes };
