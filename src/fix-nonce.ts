import { ethers } from "ethers";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

async function main() {
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC, 137);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log(`Address: ${wallet.address}`);

  const confirmedNonce = await provider.getTransactionCount(wallet.address, "latest");
  const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");

  console.log(`Confirmed nonce: ${confirmedNonce}`);
  console.log(`Pending nonce: ${pendingNonce}`);

  if (pendingNonce <= confirmedNonce) {
    console.log("\n✅ No stuck transactions");
    return;
  }

  console.log(`\n⚠️  ${pendingNonce - confirmedNonce} stuck transaction(s) detected!`);

  if (process.argv[2] !== "--clear") {
    console.log("\nRun with:");
    console.log("  npx tsx src/fix-nonce.ts --clear");
    return;
  }

  console.log("\nClearing stuck transactions...\n");

  // FIX: Go FORWARD from confirmedNonce, not backward from pendingNonce
  for (let nonce = confirmedNonce; nonce < pendingNonce; nonce++) {
    console.log(`Replacing nonce ${nonce}...`);

    let gasPrice: bigint;

    try {
      // Get current network gas price
      const feeData = await provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || 100n * 10n ** 9n; // fallback 100 gwei
      
      // Use 3x current gas price to ensure replacement
      // Polygon requires at least 10% bump, but we use 3x to be safe
      gasPrice = baseGasPrice * 3n;
      
      // Cap at 500 gwei to avoid paying too much
      const maxGasPrice = 2000n * 10n ** 9n;
      if (gasPrice > maxGasPrice) {
        gasPrice = maxGasPrice;
      }
      
      // Ensure minimum of 150 gwei for Polygon
      const minGasPrice = 150n * 10n ** 9n;
      if (gasPrice < minGasPrice) {
        gasPrice = minGasPrice;
      }

    } catch (err) {
      // Hard fallback if fee data fetch fails
      console.log(`  Warning: Could not fetch gas price, using fallback`);
      gasPrice = 200n * 10n ** 9n; // 200 gwei fallback
    }

    console.log(`  Using gasPrice: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

    try {
      const tx = await wallet.sendTransaction({
        to: wallet.address,
        value: 0,
        nonce: nonce,
        gasLimit: 21_000,
        gasPrice,
      });

      console.log(`  Tx hash: ${tx.hash}`);
      
      // Wait for confirmation with timeout
      const receipt = await Promise.race([
        tx.wait(1),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Transaction timeout")), 60000)
        )
      ]);
      
      console.log(`  ✅ Confirmed\n`);
    } catch (txError: any) {
      if (txError.code === "REPLACEMENT_UNDERPRICED") {
        console.log(`  ⚠️  Still underpriced, trying with higher gas...`);
        
        // Try again with even higher gas
        const higherGasPrice = gasPrice * 2n;
        console.log(`  Using gasPrice: ${ethers.formatUnits(higherGasPrice, "gwei")} gwei`);
        
        const retryTx = await wallet.sendTransaction({
          to: wallet.address,
          value: 0,
          nonce: nonce,
          gasLimit: 21_000,
          gasPrice: higherGasPrice,
        });

        console.log(`  Tx hash: ${retryTx.hash}`);
        await retryTx.wait(1);
        console.log(`  ✅ Confirmed\n`);
      } else {
        throw txError;
      }
    }
  }

  console.log("🎉 All stuck transactions cleared");
}

main().catch((err) => {
  console.error("\n❌ Failed:", err);
  process.exit(1);
});