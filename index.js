/**
 * index.js
 *
 * A simple Express server that continuously scans the Solana blockchain
 * for newly created SPL token mints by decoding the InitializeMint instruction
 * directly (rather than searching logs).
 */
const express = require('express');
const {
  Connection,
  clusterApiUrl,
  PublicKey
} = require('@solana/web3.js');

const {
  TOKEN_PROGRAM_ID,
  decodeInitializeMintInstruction
} = require('@solana/spl-token');

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 3000;
const SOLANA_CLUSTER = 'mainnet-beta'; // or 'devnet', 'testnet'
const POLL_INTERVAL_MS = 5000;         // How frequently to poll for new slots
// ------------------------------------------------

// 1. Create a Solana connection
const connection = new Connection(clusterApiUrl(SOLANA_CLUSTER), 'confirmed');

// 2. Variables to track the last processed slot and discovered mints in memory
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

// Start listening
app.listen(PORT, async () => {
  console.log(`\nSolana Mint Indexer is running on port ${PORT}...`);

  // Initialize lastSlot to current slot
  lastSlot = await connection.getSlot();
  console.log(`Starting block scanning from slot ${lastSlot}`);

  // Begin polling for new blocks
  pollNewBlocks();
});

/**
 * pollNewBlocks:
 * Continuously fetches blocks above the last processed slot,
 * inspects each transaction's instructions, and decodes
 * SPL Token "InitializeMint" instructions.
 */
async function pollNewBlocks() {
  while (true) {
    try {
      // Get the current slot
      const currentSlot = await connection.getSlot();

      // Process any new slots that have appeared
      for (let slot = lastSlot + 1; slot <= currentSlot; slot++) {
        // Fetch block with FULL transaction details (so we can decode instructions)
        const block = await connection.getBlock(slot, {
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'full', // necessary to see instructions
        });
        if (!block) continue; // if block is null or unavailable, skip

        // Loop over each transaction in the block
        for (const tx of block.transactions) {
          const { transaction, meta } = tx;
          if (!transaction) continue;

          const message = transaction.message;
          const accountKeys = message.accountKeys.map((k) => k.toBase58());

          // For each compiled instruction, check if it's for the TOKEN_PROGRAM_ID
          for (const ix of message.instructions) {
            const programIdIndex = ix.programIdIndex;
            const programId = message.accountKeys[programIdIndex];

            // Check if it matches the SPL Token program
            if (programId.equals(TOKEN_PROGRAM_ID)) {
              // Build a TransactionInstruction-like object for decoding
              // We need to pass:
              //  - programId: The actual PublicKey
              //  - keys: each account in the instruction
              //  - data: the raw instruction data (base64 -> Buffer)
              const instructionData = {
                programId,
                keys: ix.accounts.map((accIndex) => {
                  const pubkey = message.accountKeys[accIndex];
                  // We can check which accounts are signers/writable from the message
                  // but for decoding InitializeMint, only the order matters
                  return {
                    pubkey,
                    isSigner: message.isAccountSigner(accIndex),
                    isWritable: message.isAccountWritable(accIndex),
                  };
                }),
                data: Buffer.from(ix.data, 'base64'),
              };

              // Attempt to decode as InitializeMint
              try {
                const decoded = decodeInitializeMintInstruction(instructionData, programId);
                // If we get here, it's definitely an InitializeMint instruction

                const mintAddress = decoded.keys.mint.pubkey.toBase58();
                newMints.add(mintAddress);

                console.log(`Discovered new mint at slot ${slot}: ${mintAddress}`);
              } catch (err) {
                // decodeInitializeMintInstruction will throw if this instruction
                // isn't actually "InitializeMint", or if data is malformed.
                // We ignore that, because not every Token Program instruction is initMint.
              }
            }
          }
        }
      }

      // Update lastSlot
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}
