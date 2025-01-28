/**
 * index.js
 * 
 * A simple Express server that continuously scans the Solana blockchain
 * for newly created SPL token mints. It stores discovered mint addresses in-memory
 * and serves them over a basic REST API. 
 */
const express = require('express');
const { Connection, clusterApiUrl } = require('@solana/web3.js');

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 3000;
const SOLANA_CLUSTER = 'mainnet-beta'; // or 'devnet', 'testnet'
const POLL_INTERVAL_MS = 5000;         // How frequently to poll for new slots/blocks
// ------------------------------------------------

// 1. Create a Solana connection.
const connection = new Connection(clusterApiUrl(SOLANA_CLUSTER), 'confirmed');

// 2. Variables to track the last processed slot and newly created mints in memory.
let lastSlot = 0;
const newMints = new Set(); // Store unique mint addresses (avoid duplicates)

// 3. Start Express server.
const app = express();

// Serve our static front-end from /public
app.use(express.static('public'));

/**
 * GET /api/mints
 * Returns an array of discovered mint addresses (newly created SPL tokens).
 */
app.get('/api/mints', (req, res) => {
  // Convert Set to array before sending
  return res.json(Array.from(newMints));
});

// Start listening
app.listen(PORT, async () => {
  console.log(`\nSolana Mint Indexer is running on port ${PORT}...`);

  // Initialize lastSlot to current slot at startup
  lastSlot = await connection.getSlot();
  console.log(`Starting block scanning from slot ${lastSlot}`);

  // Begin polling for new blocks
  pollNewBlocks();
});

/**
 * pollNewBlocks:
 * Continuously checks for new slots, retrieves block data, and searches
 * for "InitializeMint" instructions in transaction logs.
 */
async function pollNewBlocks() {
  while (true) {
    try {
      // Get the current slot
      const currentSlot = await connection.getSlot();
      
      // Scan any blocks that appeared since lastSlot
      for (let slot = lastSlot + 1; slot <= currentSlot; slot++) {
        const block = await connection.getBlock(slot, {
          maxSupportedTransactionVersion: 0, // Ensures we get legacy tx details
        });
        if (!block) continue; // If block is null, skip (sometimes can happen)

        // Each block has an array of transactions
        for (const tx of block.transactions) {
          // We'll parse logs for an "InitializeMint" instruction
          const logs = tx.meta?.logMessages || [];
          const foundInitialize = logs.some(line => line.includes("InitializeMint"));
          if (!foundInitialize) continue;

          // If we see "InitializeMint", attempt to extract the Mint address from the logs
          // Typically we might see lines like "Program log: Mint: <publicKey>"
          const mintLogLine = logs.find(line => line.includes("Mint: "));
          if (mintLogLine) {
            // Example: "Program log: Mint: 4Z8QX...somePublicKey"
            const parts = mintLogLine.split("Mint: ");
            if (parts.length === 2) {
              const mintAddr = parts[1].trim();
              // Store it in our Set
              newMints.add(mintAddr);
              console.log(`Discovered new mint at slot ${slot}: ${mintAddr}`);
            }
          } else {
            // Possibly parse deeper or fetch transaction details if logs are incomplete
            // For now, just note that we found an InitializeMint but didn't parse the address
            console.log(`InitializeMint found in slot ${slot} but no 'Mint:' log line. Tx signature: ${tx.transaction.signatures[0]}`);
          }
        }
      }

      // Update lastSlot to current
      lastSlot = currentSlot;
    } catch (err) {
      console.error('Error in pollNewBlocks loop:', err);
    }

    // Wait a bit before scanning again
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Helper: Sleep for N ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
