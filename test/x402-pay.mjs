// x402 purchases from a wallet (buy, buyDataset, buyCredits) against a stub pay service, with a wallet key
// generated here and never stored. The payment the SDK sends is checked two ways: its EIP-3009 signature
// recovers to the wallet over USDC's domain, and its structure is the one @x402/core's x402Client builds with
// @x402/evm's ExactEvmScheme for the same 402. viem and @x402/* are devDependencies for tests only.
//   npm run build && npm test
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, recoverTypedDataAddress, verifyTypedData } from "viem";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ACK_KEY, ACK_TYPES, AlreadyCovered, PaymentRequiredError, TermsAckError, TRANSFER_TYPES, USDC, Witan, WitanError, ackDomain, ackItem, ackStatement, witanTermsAck } from "../dist/index.js";

const BASE = "http://api.test";
const PAY = "http://pay.test";
const SEPOLIA = "eip155:84532";
const BASE_MAINNET = "eip155:8453";
const TX = "0x" + "ab".repeat(32);
const hex = (n) => "0x" + [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const PAY_TO = hex(20); // lowercase, as a split address may come: the payment carries it checksummed
const b64 = (v) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
const unb64 = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

beforeEach(() => {
  for (const k of ["WITAN_X402_NETWORKS", "WITAN_MAX_PRICE", "WITAN_ACCEPT_TERMS", "WITAN_PAY_URL", "WITAN_BASE_URL", "WITAN_API_KEY"]) delete process.env[k];
});

const option = (over = {}) => ({
  scheme: "exact", network: SEPOLIA, amount: "100000", asset: USDC[SEPOLIA], payTo: PAY_TO, maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" }, ...over,
});
const ackInfo = (over = {}) => ({
  version: "1", termsVersion: "2026-11-30", termsHash: hex(32), legalUrl: "https://witan.markets/legal/terms-summary",
  item: "unit:u-1", price: "100000", payTo: PAY_TO, network: SEPOLIA, nonce: hex(32),
  expiry: Math.floor(Date.now() / 1000) + 600, required: false, ...over,
});
const paymentRequired = ({ accepts = [option()], ack = ackInfo(), version = 2, resource = "/paid/knowledge?id=u-1" } = {}) => ({
  x402Version: version,
  error: "Payment required",
  resource: { url: PAY + resource, description: "Full body of a WITAN knowledge unit", mimeType: "application/json" },
  accepts,
  extensions: {
    "witan-notice": { info: { seller: "Ünïcödé Seller ✓", withdrawal: "no withdrawal once delivered — 済" } },
    ...(ack ? { [ACK_KEY]: { info: ack, schema: { type: "object" } } } : {}),
  },
});
const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const settlement = { success: true, transaction: TX, network: SEPOLIA, payer: "" };

/** A stub pay service: the unpaid GET gets `required`, the paid one `paid(call)`. Every call is logged. */
function stub({ required = paymentRequired(), paid, first } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { method: init.method ?? "GET", url, headers };
    calls.push(call);
    if (url.origin === BASE && url.pathname === "/credits") return json(200, { operatorId: "op-7", balanceMicro: 0 });
    if (url.origin !== PAY) return json(404, { error: "no route" });
    if (!headers["payment-signature"]) return first ? first(call) : json(402, { error: "payment required" }, { "PAYMENT-REQUIRED": b64(required) });
    call.payment = unb64(headers["payment-signature"]);
    return paid ? paid(call) : json(200, { id: "u-1", body: "the full unit" }, { "PAYMENT-RESPONSE": b64({ ...settlement, payer: call.payment.payload.authorization.from }) });
  };
  return { fetch, calls };
}
function wallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = { address: account.address, signed: [], signTypedData: async (a) => { signer.signed.push(a.primaryType); return account.signTypedData(a); } };
  return { account, signer };
}
const witan = (s, opts = {}) => new Witan({ baseUrl: BASE, payUrl: PAY, apiKey: "km_test", fetch: s.fetch, ...opts });

test("buy: 402 → one signed payment → the body with the settlement under x402", async () => {
  const s = stub();
  const { account, signer } = wallet();
  const out = await witan(s).buy("u-1", { signer });
  assert.equal(out.body, "the full unit");
  assert.deepEqual(out.x402, { ...settlement, payer: account.address });
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].url.href, `${PAY}/paid/knowledge?id=u-1`);
  assert.equal(s.calls[1].url.href, `${PAY}/paid/knowledge?id=u-1`);
  assert.equal(s.calls[0].headers["payment-signature"], undefined);
  assert.equal(s.calls[0].headers.authorization, undefined, "no API key goes to the pay service");
  assert.match(s.calls[1].headers["user-agent"], /^witan-sdk-js\/0\.20\.0$/);
  assert.deepEqual(signer.signed, ["TransferWithAuthorization"], "no acknowledgement signed without acceptTerms");

  // the EIP-3009 authorization recovers to the wallet over USDC's domain, and pays what the 402 asked
  const p = s.calls[1].payment;
  const a = p.payload.authorization;
  assert.equal(a.from, account.address);
  assert.equal(a.to, getAddress(PAY_TO));
  assert.equal(a.value, "100000");
  assert.equal(a.validAfter, "0");
  assert.ok(Math.abs(Number(a.validBefore) - (Date.now() / 1000 + 300)) < 5);
  assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
  const domain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC[SEPOLIA] };
  const message = { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce };
  assert.equal(await verifyTypedData({ address: account.address, domain, types: TRANSFER_TYPES, primaryType: "TransferWithAuthorization", message, signature: p.payload.signature }), true);
  // the types are EIP-3009's, written out again here
  assert.deepEqual(TRANSFER_TYPES, { TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] });
  // another chain's domain does not verify
  assert.equal(await verifyTypedData({ address: account.address, domain: { ...domain, chainId: 8453 }, types: TRANSFER_TYPES, primaryType: "TransferWithAuthorization", message, signature: p.payload.signature }), false);
});

test("the payload is the one @x402/core's x402Client builds with @x402/evm's ExactEvmScheme", async () => {
  const required = paymentRequired({ ack: ackInfo({ required: true }) });
  const s = stub({ required });
  const { account, signer } = wallet();
  await witan(s).buy("u-1", { signer, acceptTerms: "2026-11-30" });
  const mine = s.calls[1].payment;

  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(account));
  client.registerExtension(witanTermsAck({ signer: account, item: ackItem("/paid/knowledge", { id: "u-1" }), acceptTerms: "2026-11-30" }));
  const theirs = JSON.parse(JSON.stringify(await client.createPaymentPayload(required)));

  const strip = (p) => {
    const c = structuredClone(p);
    for (const k of ["nonce", "validBefore"]) { assert.equal(typeof c.payload.authorization[k], "string"); delete c.payload.authorization[k]; }
    assert.match(c.payload.signature, /^0x[0-9a-f]{130}$/); delete c.payload.signature;
    assert.match(c.extensions[ACK_KEY].info.signature, /^0x[0-9a-f]{130}$/); delete c.extensions[ACK_KEY].info.signature;
    return c;
  };
  assert.deepEqual(strip(mine), strip(theirs));
  assert.deepEqual(Object.keys(mine), Object.keys(theirs), "same fields in the same order");
  assert.deepEqual(Object.keys(mine.payload.authorization), Object.keys(theirs.payload.authorization));
  // what pay/src/ack.ts checks: the acknowledgement recovers to the payer and is bound to this payment's nonce
  const got = mine.extensions[ACK_KEY].info;
  const msg = { statement: ackStatement(got.termsVersion), termsVersion: got.termsVersion, termsHash: got.termsHash, item: got.item,
    price: BigInt(got.price), payTo: got.payTo, nonce: got.nonce, expiry: BigInt(got.expiry), payment: mine.payload.authorization.nonce };
  const who = await recoverTypedDataAddress({ domain: ackDomain(84532), types: ACK_TYPES, primaryType: "TermsAck", message: msg, signature: got.signature });
  assert.equal(who, account.address);
  assert.deepEqual(signer.signed, ["TransferWithAuthorization", "TermsAck"]);
});

test("payTo goes out checksummed (EIP-55), as viem's getAddress writes it", async () => {
  const { signer } = wallet();
  for (let i = 0; i < 16; i++) {
    const payTo = hex(20);
    const s = stub({ required: paymentRequired({ accepts: [option({ payTo })], ack: null }) });
    await witan(s).buy("u-1", { signer });
    assert.equal(s.calls[1].payment.payload.authorization.to, getAddress(payTo));
  }
});

test("the payload without extensions or resource leaves them out, as x402Client does", async () => {
  const required = { x402Version: 2, accepts: [option({ payTo: getAddress(PAY_TO) })] };
  const s = stub({ required });
  const { account, signer } = wallet();
  await witan(s).buy("u-1", { signer });
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(account));
  const theirs = JSON.parse(JSON.stringify(await client.createPaymentPayload(required)));
  assert.deepEqual(Object.keys(s.calls[1].payment), Object.keys(theirs));
  assert.deepEqual(s.calls[1].payment.accepted, theirs.accepted);
});

// ---- limits: refused before anything is signed, and only the unpaid GET goes out ----
async function refused(required, opts = {}, pattern) {
  const s = stub({ required });
  const { signer } = wallet();
  await assert.rejects(witan(s).buy("u-1", { signer, ...opts }), (e) => {
    assert.ok(e instanceof PaymentRequiredError, `${e}`);
    assert.equal(e.status, 402);
    assert.match(e.message, pattern);
    return true;
  });
  assert.equal(s.calls.length, 1, "nothing but the unpaid request was sent");
  assert.deepEqual(signer.signed, [], "nothing was signed");
}

test("refuses a network that is not allowed (Base Sepolia only by default)", async () => {
  await refused(paymentRequired({ accepts: [option({ network: BASE_MAINNET, asset: USDC[BASE_MAINNET] })] }), {},
    /^refusing to pay: network eip155:8453 is not allowed here \(allowed: eip155:84532; opt in with networks or WITAN_X402_NETWORKS\)$/);
});

test("refuses an asset that is not USDC on that network", async () => {
  await refused(paymentRequired({ accepts: [option({ asset: "0x" + "11".repeat(20) })] }), {},
    new RegExp(`^refusing to pay: asset 0x1{40} is not USDC on eip155:84532 \\(${USDC[SEPOLIA]}\\)$`));
  // Base's USDC is not Base Sepolia's
  await refused(paymentRequired({ accepts: [option({ asset: USDC[BASE_MAINNET] })] }), {}, /is not USDC on eip155:84532/);
});

test("refuses a price above the cap (1.00 by default, maxPrice, WITAN_MAX_PRICE), in integer units", async () => {
  await refused(paymentRequired({ accepts: [option({ amount: "1000001" })] }), {},
    /^refusing to pay: the price, 1\.000001 USDC, is above the cap of 1 USDC \(raise it with maxPrice or WITAN_MAX_PRICE\)$/);
  await refused(paymentRequired(), { maxPrice: "0.05" }, /the price, 0\.1 USDC, is above the cap of 0\.05 USDC/);
  await refused(paymentRequired(), { maxPrice: 0.0999999 }, /above the cap of 0\.099999 USDC/); // rounded down
  process.env.WITAN_MAX_PRICE = "$0.09";
  await refused(paymentRequired(), {}, /above the cap of 0\.09 USDC/);
  delete process.env.WITAN_MAX_PRICE;
  // exactly at the cap is paid
  const s = stub({ required: paymentRequired({ accepts: [option({ amount: "1000000" })], ack: null }) });
  await witan(s).buy("u-1", { signer: wallet().signer });
  assert.equal(s.calls.length, 2);
});

test("refuses an amount that is not digits", async () => {
  await refused(paymentRequired({ accepts: [option({ amount: "1e5" })] }), {}, /^refusing to pay: amount "1e5" is not a USDC amount$/);
  await refused(paymentRequired({ accepts: [option({ amount: "-1" })] }), {}, /amount "-1" is not a USDC amount/);
});

test("refuses another scheme, transfer method or x402 version", async () => {
  await refused(paymentRequired({ accepts: [option({ scheme: "upto" })] }), {}, /^refusing to pay: scheme "upto" is not one this SDK pays with \(exact\)$/);
  await refused(paymentRequired({ accepts: [option({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } })] }), {}, /asset transfer method "permit2"/);
  await refused(paymentRequired({ version: 1 }), {}, /^refusing to pay: x402 version 1 is not one this SDK pays with \(2\)$/);
  await refused(paymentRequired({ accepts: [option({ extra: {} })] }), {}, /names no EIP-712 domain/);
  await refused(paymentRequired({ accepts: [] }), {}, /^refusing to pay: the 402 offers no way to pay$/);
});

test("every reason is named when no option passes; the first that passes is paid", async () => {
  await refused(paymentRequired({ accepts: [option({ network: BASE_MAINNET, asset: USDC[BASE_MAINNET] }), option({ amount: "x" })] }), {},
    /^refusing to pay: network eip155:8453 is not allowed here .*; amount "x" is not a USDC amount$/);
  const s = stub({ required: paymentRequired({ accepts: [option({ amount: "5000000" }), option({ amount: "100000", maxTimeoutSeconds: 60 })] }) });
  await witan(s).buy("u-1", { signer: wallet().signer });
  assert.equal(s.calls[1].payment.accepted.maxTimeoutSeconds, 60);
});

test("networks opt in to Base (a list, a comma list or WITAN_X402_NETWORKS); an unknown one is refused before any request", async () => {
  const base = () => paymentRequired({ accepts: [option({ network: BASE_MAINNET, asset: USDC[BASE_MAINNET] })], ack: null });
  for (const networks of [[BASE_MAINNET], `${SEPOLIA}, ${BASE_MAINNET}`, undefined]) {
    if (networks === undefined) process.env.WITAN_X402_NETWORKS = BASE_MAINNET;
    const s = stub({ required: base() });
    await witan(s).buy("u-1", { signer: wallet().signer, networks });
    assert.equal(s.calls[1].payment.accepted.network, BASE_MAINNET);
  }
  delete process.env.WITAN_X402_NETWORKS;
  const s = stub();
  await assert.rejects(witan(s).buy("u-1", { signer: wallet().signer, networks: ["eip155:1"] }),
    (e) => e instanceof PaymentRequiredError && /^network eip155:1 is not one this SDK pays on \(USDC is known on eip155:84532, eip155:8453\)$/.test(e.message));
  await assert.rejects(witan(s).buy("u-1", { signer: wallet().signer, maxPrice: "ten" }),
    (e) => e instanceof PaymentRequiredError && e.message === 'max price must be a USD amount such as 1.00, not "ten"');
  await assert.rejects(witan(s).buy("u-1", {}), (e) => e instanceof PaymentRequiredError && /^no wallet: pass signer/.test(e.message));
  assert.equal(s.calls.length, 0);
});

// ---- the terms acknowledgement ----
test("a required acknowledgement without acceptTerms is refused before anything is sent", async () => {
  const s = stub({ required: paymentRequired({ ack: ackInfo({ required: true }) }) });
  const { signer } = wallet();
  await assert.rejects(witan(s).buy("u-1", { signer }), (e) => e instanceof TermsAckError && e.code === "ack_missing" && /acceptTerms: "2026-11-30"/.test(e.message));
  assert.equal(s.calls.length, 1);
  // another version than the one named is refused the same way
  await assert.rejects(witan(s).buy("u-1", { signer, acceptTerms: "2026-01-01" }), (e) => e instanceof TermsAckError && e.code === "ack_terms_version");
  // a 402 for another item is not acknowledged
  const other = stub({ required: paymentRequired({ ack: ackInfo({ item: "unit:u-2" }) }) });
  await assert.rejects(witan(other).buy("u-1", { signer, acceptTerms: "2026-11-30" }), (e) => e instanceof TermsAckError && e.code === "ack_mismatch");
  assert.equal(other.calls.length, 1);
  assert.equal(s.calls.length, 2);
});

test("WITAN_ACCEPT_TERMS names the version when acceptTerms is not passed", async () => {
  process.env.WITAN_ACCEPT_TERMS = "2026-11-30";
  const s = stub({ required: paymentRequired({ ack: ackInfo({ required: true }) }) });
  const { signer } = wallet();
  await witan(s).buy("u-1", { signer });
  assert.deepEqual(signer.signed, ["TransferWithAuthorization", "TermsAck"]);
  assert.match(s.calls[1].payment.extensions[ACK_KEY].info.signature, /^0x/);
});

// ---- the paid request: sent once, never again ----
test("an ack_* refusal of the paid request throws PaymentRequiredError with its code, and nothing is re-sent", async () => {
  const s = stub({ required: paymentRequired({ ack: ackInfo({ required: true }) }),
    paid: () => json(402, { code: "ack_signature", error: "the terms acknowledgement does not verify" }) });
  await assert.rejects(witan(s).buy("u-1", { signer: wallet().signer, acceptTerms: "2026-11-30" }), (e) => {
    assert.ok(e instanceof PaymentRequiredError);
    assert.equal(e.code, "ack_signature");
    assert.equal(e.message, "purchase refused: the terms acknowledgement does not verify");
    return true;
  });
  assert.equal(s.calls.length, 2);
});

test("any other failure of the paid request is a WitanError, sent once", async () => {
  const invalid = stub({ paid: () => json(402, {}, { "PAYMENT-REQUIRED": b64({ ...paymentRequired(), error: "insufficient_funds" }) }) });
  await assert.rejects(witan(invalid).buy("u-1", { signer: wallet().signer }),
    (e) => e instanceof WitanError && !(e instanceof PaymentRequiredError) && e.status === 402 && e.message === "purchase failed: insufficient_funds");
  assert.equal(invalid.calls.length, 2);
  const down = stub({ paid: () => json(500, { error: "settlement failed" }) });
  await assert.rejects(witan(down).buy("u-1", { signer: wallet().signer }), (e) => e instanceof WitanError && e.status === 500 && /^purchase failed: /.test(e.message));
  assert.equal(down.calls.length, 2);
  // the connection drops after the payment went out: the SDK says so and does not try again
  const lost = stub({ paid: () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(witan(lost).buy("u-1", { signer: wallet().signer }), (e) => e instanceof WitanError && /check purchases\(\) before buying again$/.test(e.message));
  assert.equal(lost.calls.length, 2);
});

test("a first answer that is not a 402 is not paid", async () => {
  const s = stub({ first: () => json(404, { error: "not for sale" }) });
  const { signer } = wallet();
  await assert.rejects(witan(s).buy("u-1", { signer }), (e) => e instanceof WitanError && e.status === 404 && /^purchase failed: /.test(e.message));
  const bare = stub({ first: () => json(402, { error: "payment required" }) });
  await assert.rejects(witan(bare).buy("u-1", { signer }), (e) => e instanceof PaymentRequiredError && /without x402 requirements/.test(e.message));
  assert.equal(s.calls.length + bare.calls.length, 2);
  assert.deepEqual(signer.signed, []);
});

// ---- datasets and credits ----
test("buyDataset pays /paid/dataset for slug@version, and acknowledges that item", async () => {
  const required = paymentRequired({ ack: ackInfo({ item: "dataset:obs@3", required: true }), resource: "/paid/dataset?slug=obs&version=3" });
  const s = stub({ required });
  const { signer } = wallet();
  await witan(s).buyDataset("obs", { version: 3, signer, acceptTerms: "2026-11-30" });
  assert.equal(s.calls[1].url.href, `${PAY}/paid/dataset?slug=obs&version=3`);
  assert.equal(s.calls[1].payment.extensions[ACK_KEY].info.item, "dataset:obs@3");
  const latest = stub({ required: paymentRequired({ ack: null }) });
  await witan(latest).buyDataset("obs", { signer });
  assert.equal(latest.calls[0].url.href, `${PAY}/paid/dataset?slug=obs`);
});

test("buyDataset of a version the wallet already has through an update period throws AlreadyCovered (409)", async () => {
  const held = {
    error: "this wallet already has v4 of this dataset, through the update period of an earlier purchase: nothing was charged — get it at no charge with POST /redeliver {version: 4}",
    transaction: TX, version: 4, updatesUntil: "2026-12-14T00:00:00.000Z", redeliver: `GET /redeliver/statement?transaction=${TX}&wallet=0x...&version=4, ...`,
  };
  const s = stub({ required: paymentRequired({ ack: null }), paid: () => json(409, held) });
  await assert.rejects(witan(s).buyDataset("obs", { signer: wallet().signer }), (e) =>
    e instanceof AlreadyCovered && e instanceof WitanError && e.status === 409 && e.transaction === TX && e.version === 4 &&
    e.updatesUntil === held.updatesUntil && /nothing was charged/.test(e.message));
  assert.equal(s.calls.length, 2, "the payment was sent once and is not repeated");
  // any other 409 stays a plain WitanError
  const busy = stub({ required: paymentRequired({ ack: null }), paid: () => json(409, { error: "this payment authorization is already in use — sign a new one; nothing was charged" }) });
  await assert.rejects(witan(busy).buyDataset("obs", { signer: wallet().signer }), (e) =>
    e instanceof WitanError && !(e instanceof AlreadyCovered) && e.status === 409);
});

test("buyCredits pays /paid/credits for the key's operator, or the one named", async () => {
  const s = stub({ required: paymentRequired({ ack: null }), paid: () => json(200, { operatorId: "op-7", creditedMicro: 1000000, balanceMicro: 1000000, paid: "$1.00" }, { "PAYMENT-RESPONSE": b64(settlement) }) });
  const out = await witan(s).buyCredits({ signer: wallet().signer });
  assert.equal(s.calls[0].url.href, `${BASE}/credits`);
  assert.equal(s.calls[2].url.href, `${PAY}/paid/credits?operator=op-7`);
  assert.equal(out.creditedMicro, 1000000);
  assert.equal(out.x402.transaction, TX);
  const named = stub({ required: paymentRequired({ ack: null }) });
  await witan(named).buyCredits({ operatorId: "op-9", signer: wallet().signer });
  assert.equal(named.calls[0].url.href, `${PAY}/paid/credits?operator=op-9`);
});
