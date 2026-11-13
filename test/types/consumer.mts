// A consumer of the published types (dist/index.d.ts), compiled by test/types.sh with the oldest
// TypeScript that Requirements names, once with the DOM library and once with @types/node only.
import { Witan, WitanError, verifyManifest, type SearchHit, type QueryResult, type Earnings, type NextPayout } from "../../dist/index.js";

const w = new Witan({ baseUrl: "http://127.0.0.1:8686", apiKey: "token" });
export async function use(): Promise<number> {
  const hits: SearchHit[] = await w.search("latency", { limit: 5 });
  const q: QueryResult = await w.projects.query("p", "SELECT 1");
  const keys = await w.keys();
  const m = await w.projects.manifest("p");
  const status: string = await verifyManifest(m, keys);
  try { await w.read(hits[0].id); } catch (e) { if (e instanceof WitanError) return e.status; }
  return q.rows.length + status.length;
}

// submit needs a source declaration and takes a listed license only (0.12.1)
export async function submitTypes(): Promise<void> {
  await w.submit({ title: "t", body: "b", category: "c", sourceDeclaration: "own run", license: "CC-BY-4.0" });
  // @ts-expect-error sourceDeclaration is required
  await w.submit({ title: "t", body: "b", category: "c" });
  // @ts-expect-error not a license the origin lists
  await w.submit({ title: "t", body: "b", category: "c", sourceDeclaration: "own run", license: "MIT" });
  // a node takes any project license
  await w.projects.create({ slug: "s", title: "t", readme: "r", schemaDef: { fields: [] }, license: "MIT" });
}

// earnings (0.14.0): the payout state is a closed set
export async function earningsTypes(): Promise<number> {
  const e: Earnings = await w.earnings();
  const next: NextPayout = e.nextPayout;
  // @ts-expect-error not a payout state the origin sends
  const wrong: NextPayout = "paid";
  return e.payableMicro + (e.addressHoldUntil === null ? 0 : 1) + next.length + wrong.length;
}

// the terms acknowledgement (0.19.0): an x402 client extension, for a signer shaped like a viem account
import { ackItem, witanTermsAck, TermsAckError, type TermsAckSigner } from "../../dist/index.js";
interface X402Payload { x402Version: number; accepted: { scheme: string; network: string; amount: string }; payload: Record<string, unknown>; extensions?: Record<string, unknown> }
interface X402Required { x402Version: number; accepts: unknown[]; extensions?: Record<string, unknown> }
interface X402ClientExtension { key: string; enrichPaymentPayload?: (p: X402Payload, r: X402Required) => Promise<X402Payload> }
export function ackTypes(signer: TermsAckSigner): X402ClientExtension {
  const ext: X402ClientExtension = witanTermsAck({ signer, item: ackItem("/paid/dataset", { slug: "s", version: 3 }), acceptTerms: "2026-11-30" });
  // @ts-expect-error the signer is required
  witanTermsAck({ item: "unit:u-1" });
  const e = new TermsAckError("ack_missing", "m");
  // @ts-expect-error not a refusal code
  const wrong: TermsAckError["code"] = "ack_unsigned";
  return e.code.length + String(wrong).length > 0 ? ext : ext;
}

// a signer adapted from a wallet library shaped like ethers v6 (docs/guide/paying.md): it signs both payloads (0.20.0)
import type { WalletSigner } from "../../dist/index.js";
type Field = { name: string; type: string };
declare const ethersLike: { address: string; signTypedData(domain: object, types: Record<string, Field[]>, value: Record<string, unknown>): Promise<string> };
export const adapted: WalletSigner = {
  address: ethersLike.address,
  signTypedData: ({ domain, types, message }: { domain: object; types: object; message: Record<string, unknown> }) =>
    ethersLike.signTypedData(domain, types as Record<string, Field[]>, message),
};
