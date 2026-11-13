// The terms acknowledgement signed with a real key (generated here, never stored) and recovered the
// way the pay service does it, with its types and domain written out again from pay/src/ack.ts — so a
// drift in the SDK's copy fails here. viem is a devDependency for this test only; the SDK has none.
//   npm run build && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { ACK_KEY, ackItem, witanTermsAck } from "../dist/index.js";

// pay/src/ack.ts, verbatim
const ackStatement = (termsVersion) =>
  `I have read the WITAN terms (version ${termsVersion}) and the key terms of this purchase, and I agree to them.`;
const ACK_TYPES = {
  TermsAck: [
    { name: "statement", type: "string" },
    { name: "termsVersion", type: "string" },
    { name: "termsHash", type: "bytes32" },
    { name: "item", type: "string" },
    { name: "price", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint256" },
    { name: "payment", type: "bytes32" },
  ],
};
const ackDomain = (chainId) => ({ name: "WITAN Terms Acknowledgement", version: "1", chainId });

test("a viem account signs the acknowledgement, and pay's check recovers the payer", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const info = {
    version: "1", termsVersion: "2026-11-30", termsHash: "0x" + "cd".repeat(32), legalUrl: "https://witan.markets/legal/terms-summary",
    item: "unit:u-1", price: "100000", payTo: "0x" + "22".repeat(20), network: "eip155:84532", nonce: "0x" + "ef".repeat(32),
    expiry: Math.floor(Date.now() / 1000) + 600, required: true,
  };
  const required = { x402Version: 2, accepts: [], extensions: { [ACK_KEY]: { info, schema: { type: "object" } } } };
  const payload = {
    x402Version: 2, accepted: { scheme: "exact", network: "eip155:84532", amount: "100000" },
    payload: { signature: "0x", authorization: { from: account.address, to: info.payTo, value: "100000", nonce: "0x" + "12".repeat(32) } },
  };
  const ext = witanTermsAck({ signer: account, item: ackItem("/paid/knowledge", { id: "u-1" }), acceptTerms: "2026-11-30" });
  const out = await ext.enrichPaymentPayload(payload, required);
  const got = out.extensions[ACK_KEY].info;
  assert.equal(got.signer, account.address);
  assert.match(got.signature, /^0x[0-9a-f]{130}$/);
  // what pay/src/ack.ts check() does with the paid request
  const a = out.payload.authorization;
  assert.equal(got.signer.toLowerCase(), a.from.toLowerCase());
  const message = {
    statement: ackStatement(got.termsVersion), termsVersion: got.termsVersion, termsHash: got.termsHash, item: got.item,
    price: BigInt(got.price), payTo: got.payTo, nonce: got.nonce, expiry: BigInt(got.expiry), payment: a.nonce,
  };
  const signer = await recoverTypedDataAddress({ domain: ackDomain(84532), types: ACK_TYPES, primaryType: "TermsAck", message, signature: got.signature });
  assert.equal(signer.toLowerCase(), account.address.toLowerCase());
  // and it is bound to this payment: another authorization nonce recovers someone else
  const other = await recoverTypedDataAddress({ domain: ackDomain(84532), types: ACK_TYPES, primaryType: "TermsAck", message: { ...message, payment: "0x" + "34".repeat(32) }, signature: got.signature });
  assert.notEqual(other.toLowerCase(), account.address.toLowerCase());
});
