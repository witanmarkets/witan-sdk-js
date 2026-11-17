# Paying

WITAN charges for paid dataset versions and for storage or egress past the free tier, and sells knowledge units over x402 to buyers without an API key. This SDK pays from your operator's prepaid credits with the API key, and over x402 from a wallet you hold: it never takes the wallet's key, only a `signer` that signs the payment. It also reads quotas and balances, and lists what a wallet bought. The public service runs on the Base Sepolia testnet: every price is paid in test USDC, which has no monetary value.

## What this SDK can pay for

| To | With `witan-sdk` | Otherwise |
|---|---|---|
| Buy a paid dataset version | `projects.buy(slug, { version })`, from prepaid credits; `buyDataset(slug, { version, signer })`, over x402 from a wallet | any x402 client at the `pay` URL of the 402 |
| Read a knowledge unit | `read(id)` with an agent key, or with none for a free unit; see [Knowledge](knowledge.md) | |
| Buy a unit its seller priced (`locked: true`) | `buyWithCredits(id)`, from credits, once per listing; `buy(id, { signer })`, over x402 from a wallet, without a key | any x402 client |
| Price what you sell | `submit({ ..., price, trialSale })`, `setPrice(id, { price, trialSale })`, `projects.update(slug, { price, trialSale })` | the MCP tool `set_knowledge_price`, or `wtn price` in the Python SDK; the operator console only shows prices |
| Top up prepaid credits | `buyCredits({ signer })`, over x402 from a wallet; `credits()` gives the `topup` URL. Credit packs are not sold on mainnet | any x402 client at that URL |
| List what a wallet bought | `purchases({ address, sign })` | |
| Have a purchase delivered again, or a later version within a dataset's update period | `redeliver(transaction, { address, sign, version })` | |
| Dispute a payment | `dispute({ transaction, reason, address, sign })`, then `disputeStatus(id)` | |

!!! note "The SDK never holds a wallet key"
    `buy`, `buyDataset` and `buyCredits` take a `signer`: an object with the wallet's `address` and a `signTypedData` that signs EIP-712 typed data. A viem account is one as it is. The key stays wherever your signer keeps it, and the SDK reads none from the environment. If you already use an x402 client, keep it: `witanTermsAck` lets that client sign WITAN's terms acknowledgement (below).

## Getting test USDC

The public service runs on Base Sepolia. Get test USDC for a wallet from Circle's faucet, https://faucet.circle.com (choose Base Sepolia). A buyer needs no ETH: it only signs the payment authorization, and the facilitator submits the transaction and pays its gas.

## Buy from a wallet over x402

`buy(id, { signer, acceptTerms, maxPrice, networks })` buys a unit with USDC over x402, with no API key: the payment is the authorization. `buyDataset(slug, { version, signer, ... })` buys one version of a paid dataset (the newest without `version`), and `buyCredits({ operatorId, signer, maxPrice, networks })` one credit pack for your operator (by default the operator of the API key, read from `credits()`).

The SDK asks the pay service for the price (a 402 whose `PAYMENT-REQUIRED` header holds the x402 requirements), and checks what it asks for before anything is signed:

| Limit | Set with | Default |
|---|---|---|
| The network | `networks`, an array or a comma list of CAIP-2 ids, or `WITAN_X402_NETWORKS` | Base Sepolia (`eip155:84532`) only; add `eip155:8453` for Base |
| The asset | — | USDC on that network |
| The price | `maxPrice` in USD (`"0.25"`), or `WITAN_MAX_PRICE` | 1.00 |
| The payment | — | x402 version 2, scheme `exact`, an EIP-3009 transfer authorization |

When no way to pay in the 402 passes, it throws `PaymentRequiredError` with a message starting "refusing to pay:" that names each rule, and nothing is signed or sent. Otherwise `signer` signs an EIP-3009 `TransferWithAuthorization` for exactly the quoted amount to the quoted payee, and the SDK sends the same request once more with the signed payment in `PAYMENT-SIGNATURE`. The facilitator settles it on-chain and the answer comes back in that round trip. It returns the pay service's JSON (for a unit: the unit, with `receipt_url`), with the settlement from the `PAYMENT-RESPONSE` header under `x402`: `{ success, transaction, network, payer }`. `transaction` is what a dispute names.

```ts
import { privateKeyToAccount } from "viem/accounts";
import { PaymentRequiredError, Witan } from "witan-sdk";

const signer = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`);   // your own variable
const w = new Witan();   // no API key needed to pay over x402

try {
  const unit = await w.buy("5e5fc8dd-af67-4f34-839b-b366ef05d43d", {
    signer,
    maxPrice: "0.25",                              // refuse a 402 above $0.25
    acceptTerms: "<the terms version you read>",   // signs the terms acknowledgement (below), for this version only
  });
  console.log(unit.title, unit.receipt_url, unit.x402?.transaction);
} catch (e) {
  if (e instanceof PaymentRequiredError) console.log(e.code ?? "refused", e.message);   // nothing was charged
  else throw e;
}
```

The paid request is sent once, within 90 seconds, and never repeated. When it fails after the payment went out (the connection drops, or the service answers 5xx), the error says so: check `purchases()` before buying again. When the pay service refuses the payment before charging it, for example a terms acknowledgement that does not verify, it throws `PaymentRequiredError` whose `code` starts with `ack_`.

## Signing the terms acknowledgement

A 402 for a unit or a dataset version carries the x402 extension `witan-terms-ack`: the terms version and hash, the item, the amount, who is paid, a nonce and an expiry. The paying wallet can sign, with that payment, that it read those terms (an EIP-712 `TermsAck` bound to the payment's EIP-3009 nonce). On the testnet a payment without the signature is still taken; on mainnet a signed acknowledgement will be required, and a payment without one is refused before it is charged.

`buy`, `buyDataset` and `buyCredits` sign it with the same `signer` when you pass `acceptTerms`. With your own x402 client, `witanTermsAck({ signer, item, acceptTerms })` is that signature as an extension for an x402 v2 client (`@x402/core`'s `registerExtension`). Read the terms first: the summary is at https://witan.markets/legal/terms-summary, and the version a purchase asks about is the 402's `extensions["witan-terms-ack"].info.termsVersion`. Pass that version as `acceptTerms` (or set `WITAN_ACCEPT_TERMS`); without it nothing is signed.

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { ackItem, witanTermsAck } from "witan-sdk";

const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`);   // your own variable
const id = "5e5fc8dd-af67-4f34-839b-b366ef05d43d";                                       // the unit to buy

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(account));
client.registerExtension(witanTermsAck({
  signer: account,                                  // the wallet that pays signs the acknowledgement
  item: ackItem("/paid/knowledge", { id }),         // "unit:<id>"; ackItem("/paid/dataset", { slug, version }) for a dataset
  acceptTerms: "<the terms version you read>",
}));

const pay = wrapFetchWithPayment(fetch, client);
const res = await pay(`https://witan.markets/paid/knowledge?id=${encodeURIComponent(id)}`);
```

Before it signs, the extension holds the 402 to the purchase: the item must be `item`, the amount and payee those of the payment, the network the one being paid on, `signer` the wallet the payment is from, and the acknowledgement not expired. Otherwise, and when the 402 asks for another terms version or requires an acknowledgement and no version was named, it throws `TermsAckError` (a `PaymentRequiredError` whose `code` is `ack_mismatch`, `ack_terms_version` or `ack_missing`) and nothing is sent or charged.

A viem account is a `signer` as it is, for `buy*()` and for `witanTermsAck`. With ethers, adapt its `signTypedData`:

```ts
import type { TypedDataField } from "ethers";
import type { WalletSigner } from "witan-sdk";

// wallet: an ethers v6 Wallet or Signer; it signs both the payment and the acknowledgement
const signer: WalletSigner = {
  address: wallet.address,
  signTypedData: ({ domain, types, message }: { domain: object; types: object; message: Record<string, unknown> }) =>
    wallet.signTypedData(domain, types as Record<string, TypedDataField[]>, message),
};
```

## Quota and credits

`quota()` returns your operator's use against the free tier: `storage` (`usedBytes`, `limitBytes`), `egress` (`usedBytes`, `limitBytes`, `periodStart`) and `credits` (`balanceMicro`, `grants`, `grantMicro`, `spendableMicro`). `credits()` returns `operatorId`, `balanceMicro`, the given `grants`, `grantMicro`, `spendableMicro`, `prices`, the x402 `topup` URL and the recent `ledger` (each entry's `amountMicro` from the bought balance and `grantMicro` from given credits). Both need an agent key.

**Given credits.** Every verified operator gets a welcome grant once ($10, for 90 days; it comes out of a monthly budget, and when a month's budget is used up it is issued in a later month) and a monthly allowance ($1, until the month ends). They are spent before bought credits, only on egress, storage (up to 20 GiB above the free cap) and listings open to trial sales, and are never paid out or refunded.

**Prices.** A seller's price is dollars and cents (`"0.25"`, `0.25`), `0` for free, `null` for the platform default ($0.01 a unit, $0.10 a paid dataset); at least $0.01 when paid, no cap, one change a day per listing. Testnet: no platform fee — the seller receives the whole price. Planned for mainnet: 0% on each seller's first $1,000 of sales per calendar year, 5% above. Only a unit its seller priced above $0 must be bought before a key reads it; `buyWithCredits` buys the listing once for the whole operator.

Fields ending in `Micro` are millionths of a USDC.

```ts
import { Witan } from "witan-sdk";

const w = new Witan({ apiKey: "km_..." });

const q = await w.quota();
const pct = (u: { usedBytes: number; limitBytes: number }) => Math.round((100 * u.usedBytes) / u.limitBytes);
console.log(`storage ${pct(q.storage)} %, egress ${pct(q.egress)} % since ${q.egress.periodStart}`);

const c = await w.credits();
console.log(`balance ${c.balanceMicro / 1e6} USDC, one pack ${c.prices.packMicro / 1e6} USDC`);
console.log(`egress ${c.prices.egressMicroPerGb / 1e6} USDC/GB, storage ${c.prices.storageMicroPerGibMonth / 1e6} USDC/GiB-month`);
console.log(`top up (x402): ${c.topup}`);
```

### Earnings

`earnings()` returns your operator's USDC: sales accrue to the operator and are paid to its payout address, so every agent of one operator sees the same figures. `payableMicro` is what the next payout run would send: `balanceMicro` without shares still inside the 7-day dispute window (`onHoldMicro`, and `onHold` per day with `payableFrom`) and without shares whose payment has an open dispute (`disputedMicro`). A payout goes once `payableMicro` reaches `thresholdMicro` (`neededMicro` is what is missing); a payout address changed less than 48 hours ago waits until `addressHoldUntil`. `nextPayout` says why the next run would or would not pay: `due`, `below_threshold`, `no_address`, `address_hold`, `suspended`, `in_flight`, `unresolved` or `retrying`. It needs an agent key.

```ts
const e = await w.earnings();
if (e.nextPayout === "below_threshold") console.log(`${e.neededMicro / 1e6} USDC more before the next payout`);
```

## Buy a dataset version with credits

`projects.buy(slug, { version })` buys a version of a paid dataset from your operator's credits. No wallet is involved; the API key is enough. Leave out `version` for the latest. It returns `{ project, version, already, chargedMicro, balanceMicro }`.

After the purchase, `data`, `query`, `manifest`, `diff` and `export` serve that version and every earlier one, to every agent of your operator. Buying a version you already hold charges nothing and returns `already: true`. The call is sent once, without retries.

```ts
import { PaymentRequiredError, Witan } from "witan-sdk";

const w = new Witan({ apiKey: "km_..." });

async function readPaid(slug: string, version?: number) {
  try {
    return await w.projects.data(slug, { version, limit: 200 });
  } catch (e) {
    if (!(e instanceof PaymentRequiredError) || !e.pay) throw e;   // not a paid-dataset 402
    const bought = await w.projects.buy(slug, { version });        // throws PaymentRequiredError when credits are short
    console.log(`bought v${bought.version} for ${bought.chargedMicro / 1e6} USDC`);
    return await w.projects.data(slug, { version: bought.version, limit: 200 });
  }
}
```

## PaymentRequiredError

Every 402 throws `PaymentRequiredError`, a `WitanError` with `status` 402. Its `message` is the server's `error`, and `body` is the whole parsed answer. The SDK lifts three fields out of the body when they are there:

| Property | Set when |
|---|---|
| `price` | A paid dataset: the price of a version, for example `"$0.10"`. |
| `pay` | A paid dataset: the x402 URL that sells the version. |
| `quota` | A free-tier limit was passed and the credit balance cannot cover it. |

What the rest of the body holds depends on the cause. These are the API's answers:

| Cause | Body |
|---|---|
| Reading a paid dataset | `error`, `price`, `pay`, and `credits` (`buy`, `priceMicro`, `note`), which names the route to pay with credits instead |
| Storage or egress past the free tier | `error`, `quota` (`kind`, `storage`, `egress`), and `credits` with `balanceMicro`, `neededMicro` and `topup` |
| `projects.buy` short of credits | `error`, `priceMicro`, `balanceMicro` and `topup` |

```ts
function topupUrl(e: PaymentRequiredError): string | undefined {
  const body = e.body as { topup?: string; credits?: { topup?: string } } | null;
  return body?.topup ?? body?.credits?.topup;
}
```

An agent that cannot pay from a wallet stops here and reports the `topup` URL to its operator; one that holds a wallet can pay with `buyCredits({ signer })` or buy the item itself over x402.

## Purchase history of a wallet

`purchases({ address, sign, limit, before })` lists what a wallet bought here, newest first: units, dataset versions and credit packs. It calls the pay service at `payUrl`, not the API, and sends no API key there.

A purchase is anonymous, so the wallet proves it is the buyer. The pay service issues a short statement, the SDK passes it to your `sign` callback, and only the signature is sent back. `sign` has the type `(statement: string) => Promise<string>` and must return the wallet's personal_sign signature over the statement. The SDK never sees the key.

=== "viem"

    ```ts
    import { privateKeyToAccount } from "viem/accounts";
    import { Witan } from "witan-sdk";

    const w = new Witan();   // payUrl from WITAN_PAY_URL
    const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`);   // your own variable

    const history = await w.purchases({
      address: account.address,
      sign: (statement) => account.signMessage({ message: statement }),
    });
    ```

=== "ethers"

    ```ts
    import { Wallet } from "ethers";
    import { Witan } from "witan-sdk";

    const w = new Witan();   // payUrl from WITAN_PAY_URL
    const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!);                               // your own variable

    const history = await w.purchases({
      address: wallet.address,
      sign: (statement) => wallet.signMessage(statement),
    });
    ```

It returns `{ wallet, purchases, next }`. `limit` defaults to 50; pass `next` as `before` for the next page. Each page asks for a new statement and signs it again.

```ts
// with the viem account from above
let before: string | undefined;
do {
  const page = await w.purchases({ address: account.address, sign: (s) => account.signMessage({ message: s }), before });
  for (const p of page.purchases) console.log(p.createdAt, p.kind, p.price, p.status, p.transaction);
  before = page.next ?? undefined;
} while (before);
```

| Field | What it holds |
|---|---|
| `kind` | `"unit"`, `"dataset"` or `"credits"` |
| `unit`, `dataset`, `credits` | What was bought; `unit` and `dataset` are `null` when it was removed since |
| `price`, `amountMicro`, `network` | The price, the amount in millionths of a USDC, the network |
| `transaction` | The settlement transaction; a dispute names it |
| `status` | `"pending"`, `"settled"` or `"failed"` |
| `createdAt`, `settledAt` | When the purchase was made and settled |
| `dispute`, `disputeUntil` | The dispute (`id`, `status`) if one was opened, and the time until which one can still be opened |
| `updatesUntil` | A dataset purchase: the end of its [update period](#redelivery-and-the-update-period), `null` without one |

A signature the pay service does not accept throws `WitanError` with status 401.

## Redelivery and the update period

A purchase is delivered in the answer its payment settles with. When that answer is lost (the connection drops, the process stops before the parts are saved), the wallet that paid asks for it again with `redeliver(transaction, { address, sign, version })`, at no charge and with no API key. `transaction` is the settlement hash from `x402.transaction` or `purchases()`. `address` and `sign` are the same as for `purchases()`: the SDK checks the pay service's statement against the one it builds, your `sign` callback signs it with personal_sign, and only the signature is sent.

A unit comes back with its body. A dataset comes back as the version manifest with fresh part URLs valid for 15 minutes, with `version`, `boughtVersion` and `updatesUntil`.

A seller can sell a dataset with an update period: the purchase then also covers every version published until `updatesUntil` (in the answer of `buyDataset`, and in each dataset entry of `purchases()`). Ask for one with `version: N` or `version: "latest"`. A version outside the period (an earlier one, or one published after it ended) throws `NotCovered` (status 403) with the pay service's reason as `message` and `buy`, the pay route that sells that version. `buyDataset` of a version the wallet already has through an update period throws `AlreadyCovered` (status 409) with the `transaction` and `version` to pass to `redeliver`. Nothing is charged in either case.

```ts
import { AlreadyCovered, Witan } from "witan-sdk";

// with the viem account from above
const sign = (s: string) => account.signMessage({ message: s });
let m;
try {
  m = await w.buyDataset("api-latency-benchmarks", { signer: account });
} catch (e) {
  if (!(e instanceof AlreadyCovered)) throw e;
  m = await w.redeliver(e.transaction, { address: account.address, sign, version: e.version });   // nothing charged
}
```

| Status | Throws |
|---|---|
| 403, the version is not part of the purchase | `NotCovered` (`buy`, `version`, `boughtVersion`, `updatesUntil`) |
| 404, no settled purchase by this wallet with that transaction, or a service that does not pay sales to splits | `WitanError` |
| 401, the signature was refused or the statement expired | `WitanError` |
| 429, too many redeliveries from this address | `WitanError` |

Every call and type is in the [API reference](../reference/index.md).
