/**
 * index.js
 *
 * A simple Express server that continuously scans the Solana blockchain
 * for newly created SPL token mints by decoding the InitializeMint
 * instruction data (rather than searching logs).
 *
 * It also skips any transaction that doesn't have a 'message.accountKeys'
 * (e.g. versioned transactions), to avoid "Cannot read property of undefined" errors.
 */
const express = require('express');
const {
  Connection,
  clusterApiUrl,
} = require('@solana/web3.js');

const {
  TOKEN_PROGRAM_ID,
  decodeInitializeMintInstruction
} = require('@solana/spl-token');

// -------------------- CONFIG --------------------
const PORT = 5000;                        // Listen on port 5000
const HOST = '0.0.0.0';                   // Listen on IP 0.0.0.0
const SOLANA_CLUSTER = 'mainnet-beta';    // or 'devnet', 'testnet'
const POLL_INTERVAL_MS = 5000;            // How frequently to poll for new slots
// ------------------------------------------------

// 1. Create a Solana connection
const connection = new Connection(clusterApiUrl(SOLANA_CLUSTER), 'confirmed');

// 2. Track the last processed slot and discovered mints (in memory)
let lastSlot = 0;
const newMints = new Set(); // store unique mint addresses

// 3. Create an Express server
const app = express();

// Serve static front-end from /public
app.use(express.static('public'));

/**
 * GET /api/mints
 * Returns an array of discovered mint addresses
 */
app.get('/api/mints', (req, res) => {
  return res.json(Array.from(newMints));
});

// Start listening on port 5000, IP 0.0.0.0
app.listen(PORT, HOST, async () => {
  console.log(`\nSolana Mint Indexer is running on http://${HOST}:${PORT}...`);

  // Initialize lastSlot to the current slot at startup
  lastSlot = await connection.getSlot();
  console.log(`Starting block scanning from slot ${lastSlot}`);

  // Begin polling for new blocks
  pollNewBlocks();
});

/**
 * pollNewBlocks:
 * Continuously fetches blocks above the last processed slot,
 * inspects each transaction's instructions, and decodes
 * SPL Token 'InitializeMint' instructions.
 */
async function pollNewBlocks() {
  while (true) {
    try {
      // Get the current slot
      const currentSlot = await connection.getSlot();

      // Process any new slots
      for (let slot = lastSlot + 1; slot <= currentSlot; slot++) {
        // Fetch block with FULL transaction details (needed to decode instructions)
        const block = await connection.getBlock(slot, {
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0, // only legacy TX if possible
        });

        if (!block) continue; // skip if block is null/unavailable

        // Loop over each transaction in the block
        for (const tx of block.transactions) {
          const { transaction, meta } = tx;
          if (!transaction) continue;             // skip if no transaction object
          if (!transaction.message) continue;     // skip if there's no message

          // Optional: if transaction.version is not undefined and > 0, it's versioned
          if (transaction.version !== undefined && transaction.version > 0) {
            // skip versioned transactions in this demo
            continue;
          }

          const message = transaction.message;
          if (!message.accountKeys) continue; // skip if accountKeys is missing

          // Now we can safely parse each instruction
          for (const ix of message.instructions) {
            const programIdIndex = ix.programIdIndex;
            const programId = message.accountKeys[programIdIndex];

            // If the program is the SPL Token Program
            if (programId && programId.equals(TOKEN_PROGRAM_ID)) {
              // Build a TransactionInstruction-like object
              const instructionData = {
                programId,
                keys: ix.accounts.map((accIndex) => {
                  const pubkey = message.accountKeys[accIndex];
                  return {
                    pubkey,
                    isSigner: message.isAccountSigner(accIndex),
                    isWritable: message.isAccountWritable(accIndex),
                  };
                }),
                data: Buffer.from(ix.data, 'base64'),
              };

              // Try to decode as InitializeMint
              try {
                const decoded = decodeInitializeMintInstruction(
                  instructionData,
                  TOKEN_PROGRAM_ID
                );
                // If successful, it's an InitializeMint
                const mintAddress = decoded.keys.mint.pubkey.toBase58();
                newMints.add(mintAddress);

                console.log(`Discovered new mint at slot ${slot}: ${mintAddress}`);
              } catch (err) {
                // decodeInitializeMintInstruction throws if it's not actually InitializeMint
                // or if data is malformed; ignore in that case
              }
            }
          }
        }
      }

      // Update lastSlot to the current slot
      lastSlot = currentSlot;
    } catch (err) {
      console.error('Error in pollNewBlocks loop:', err);
    }

    // Wait before scanning again
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Helper: Sleep for N ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
