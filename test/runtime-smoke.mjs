// The checks a runtime must pass to be listed under Requirements, using only what a Worker or an
// Edge function has: fetch, web streams, WebCrypto. test/edge.mjs bundles this with the SDK and runs it
// in workerd (Cloudflare Workers) and in edge-runtime (Vercel Edge); Deno, Bun and Node run the unit tests.
import { USDC, Witan, signedStatement, verifyManifest } from "../dist/index.js";

const ORIGIN = "https://origin.test";
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

export async function run() {
  const out = {};
  // a search through the client, against a stub origin
  const w = new Witan({ baseUrl: "https://api.test", fetch: async (u) =>
    new URL(String(u)).pathname === "/search" ? json({ results: [{ id: "u1", title: "t", score: 1 }] }) : new Response("{}", { status: 404 }) });
  out.search = (await w.search("latency")).length === 1;
  // a manifest signed with Ed25519 verifies, and a changed one does not (WebCrypto Ed25519)
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const keys = { origin: ORIGIN, keys: [{ kid: "k1", alg: "Ed25519", publicKey: b64(raw) }] };
  const m = { format: "witan-dataset-manifest/1", project: "p", version: 1, createdAt: "2026-09-29T00:00:00Z",
    parts: [{ sha256: "a".repeat(64), bytes: 1, records: 1, url: "https://store.test/a" }],
    totals: { records: 1, bytes: 1, parts: 1, contributions: 1 }, urlExpiresAt: "2026-09-29T00:15:00Z" };
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(signedStatement(m, ORIGIN))));
  const signed = { ...m, signature: { alg: "Ed25519", kid: "k1", origin: ORIGIN, sig: b64(sig) } };
  out.verify = (await verifyManifest(signed, keys)) === "verified";
  out.tamper = await verifyManifest({ ...signed, version: 2 }, keys).then(() => false, () => true);
  // an x402 purchase against a stub pay service, with a stub wallet: the payment header (base64 of UTF-8 JSON,
  // no Buffer), the nonce (getRandomValues) and the checksummed payee (Keccak-256) are built from web APIs only
  const required = { x402Version: 2, resource: { url: "https://pay.test/paid/knowledge?id=u1" }, extensions: { "witan-notice": { info: { seller: "Ünïcödé ✓" } } },
    accepts: [{ scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC["eip155:84532"], payTo: "0x" + "ab".repeat(20), maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }] };
  const utf8b64 = (v) => b64(new TextEncoder().encode(JSON.stringify(v)));
  let sent;
  const pay = new Witan({ baseUrl: "https://api.test", payUrl: "https://pay.test", fetch: async (_u, init) => {
    const h = init.headers["PAYMENT-SIGNATURE"];
    if (!h) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": utf8b64(required) } });
    sent = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(h), (c) => c.charCodeAt(0))));
    return new Response(JSON.stringify({ id: "u1" }), { headers: { "PAYMENT-RESPONSE": utf8b64({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:84532" }) } });
  } });
  const signer = { address: "0x" + "12".repeat(20), signTypedData: async () => "0x" + "ee".repeat(65) };
  const bought = await pay.buy("u1", { signer });
  out.pay = bought.x402?.success === true && sent?.extensions?.["witan-notice"]?.info?.seller === "Ünïcödé ✓"
    && sent.payload.authorization.to === "0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB" && /^0x[0-9a-f]{64}$/.test(sent.payload.authorization.nonce);
  // gzip both ways where the runtime has the streams (push compresses, export reads .jsonl.gz)
  if (typeof CompressionStream === "undefined" || typeof DecompressionStream === "undefined") out.gzip = "absent";
  else {
    const gz = await new Response(new Blob(["x".repeat(100)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    out.gzip = (await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).text()) === "x".repeat(100);
  }
  return out;
}
