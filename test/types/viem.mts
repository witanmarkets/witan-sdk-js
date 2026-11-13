// A viem account as the signer of buy*() and witanTermsAck (0.20.0). Compiled by test/types.sh with the DOM library
// only: viem's own types need it (they name CryptoKey and WebAuthn types), so @types/node alone cannot load them.
import type { PrivateKeyAccount } from "viem/accounts";
import { Witan, witanTermsAck, type TermsAckSigner, type WalletSigner, type X402Purchase } from "../../dist/index.js";

const w = new Witan({ payUrl: "https://witan.markets" });
export async function walletTypes(account: PrivateKeyAccount): Promise<number> {
  const signer: WalletSigner = account;
  const ackSigner: TermsAckSigner = signer;
  const viemAckSigner: TermsAckSigner = account;
  witanTermsAck({ signer: account, item: "unit:u-1" });
  const bought: X402Purchase = await w.buy("u-1", { signer, acceptTerms: "2026-11-30", maxPrice: "0.25", networks: ["eip155:84532"] });
  await w.buyDataset("p", { version: 3, signer: account, maxPrice: 0.1, networks: "eip155:84532,eip155:8453" });
  await w.buyCredits({ signer: account, operatorId: "op" });
  // @ts-expect-error the signer is required
  await w.buy("u-1", {});
  // @ts-expect-error a credit pack asks for no acknowledgement
  await w.buyCredits({ signer: account, acceptTerms: "2026-11-30" });
  // @ts-expect-error a signer signs typed data
  const notSigner: WalletSigner = { address: "0x", signMessage: async () => "0x" };
  return String(bought.x402?.transaction).length + ackSigner.address.length + viemAckSigner.address.length + String(notSigner).length;
}
