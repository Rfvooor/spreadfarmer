import { ClobClient, ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { CLOB_HOST, CHAIN_ID, PRIVATE_KEY, FUNDER_ADDRESS, CLOB_CREDS } from "./config.js";

let clobClient: ClobClient | null = null;
let signer: Wallet | null = null;

export async function initClient(): Promise<ClobClient> {
  if (clobClient) return clobClient;

  if (!PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY not set in environment");
  }

  // Use ethers v5 Wallet (required by @polymarket/clob-client)
  signer = new Wallet(PRIVATE_KEY);
  const funder = FUNDER_ADDRESS || signer.address;

  console.log(`[Client] Address: ${signer.address}, chainId: ${CHAIN_ID}`);

  let creds: ApiKeyCreds;
  if (CLOB_CREDS) {
    creds = CLOB_CREDS;
    console.log("[Client] Using provided API credentials");
  } else {
    // Create temp client just for key derivation (minimal params)
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
    creds = await tempClient.createOrDeriveApiKey();
    console.log("[Client] Derived API credentials");
  }

  // Create full client with credentials
  // Only pass funder if different from signer
  if (funder !== signer.address) {
    clobClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      signer,
      creds,
      undefined, // signatureType - let it default
      funder
    );
  } else {
    clobClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      signer,
      creds
    );
  }

  console.log(`[Client] Initialized for address ${signer.address}`);
  return clobClient;
}

export function getClient(): ClobClient {
  if (!clobClient) {
    throw new Error("Client not initialized. Call initClient() first.");
  }
  return clobClient;
}

export function getSigner(): Wallet {
  if (!signer) {
    throw new Error("Signer not initialized. Call initClient() first.");
  }
  return signer;
}
