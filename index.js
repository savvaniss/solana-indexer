/**
 * index.js
 * 
 * A robust Express server that continuously scans the Solana blockchain
 * for newly created SPL token mints by decoding the InitializeMint
 * instruction data. Incorporates a slot lag to ensure blocks are available
 * and includes enhanced logging for better visibility.
 */

const express = require('express');
const {
  Connection,
  clusterApiUrl,
  PublicKey,
} = require('@solana/web3.js');
const borsh = require('borsh');
const {
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// -------------------- CONFIG --------------------
const PORT = 5000;                        // Listen on port 5000
const HOST = '0.0.0.0';                   // Listen on IP 0.0.0.0
const SOLANA_CLUSTER = 'devnet';          // 'mainnet-beta' or 'devnet' for testing
const POLL_INTERVAL_MS = 5000;            // How frequently to poll for new slots (in ms)
const SLOT_LAG = 2;                        // Number of slots to lag behind to ensure block availability
const MINTS_FILE = path.join(__dirname, 'mints.json'); // File to persist mints
// ------------------------------------------------

// 1. Create a Solana connection
const connection = new Connection(clusterApiUrl(SOLANA_CLUSTER), 'confirmed');

// 2. Track the last processed slot and discovered mints (in memory)
let lastSlot = 0;
const newMints = new Set(); // Store unique mint addresses

// Load existing mints from file (if any)
if (fs.existsSync(MINTS_FILE)) {
  try {
    const data = fs.readFileSync(MINTS_FILE, 'utf-8');
    const mintsArray = JSON.parse(data);
    mintsArray.forEach(mint => newMints.add(mint));
    console.log(`Loaded ${mintsArray.length} mints from ${MINTS_FILE}`);
  } catch (err) {
    console.error(`Failed to load mints from ${MINTS_FILE}:`, err);
  }
}

// 3. Define Borsh Schema for InitializeMint
class InitializeMintInstructionData {
  constructor(fields) {
    this.instruction = fields.instruction;
    this.decimals = fields.decimals;
    this.mintAuthority = fields.mintAuthority;
    this.freezeAuthorityOption = fields.freezeAuthorityOption;
    this.freezeAuthority = fields.freezeAuthority;
  }
}

const InitializeMintSchema = new Map([
  [
    InitializeMintInstructionData,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'], // InitializeMint instruction is 0
        ['decimals', 'u8'],
        ['mintAuthority', [32]],
        ['freezeAuthorityOption', 'u8'], // 0 or 1
        ['freezeAuthority', [32]],        // Present only if freezeAuthorityOption == 1
      ],
    },
  ],
]);

/**
 * Manually decode InitializeMint instruction
 */
function decodeInitializeMintInstruction(instructionData) {
  const buffer = instructionData.data;
  const decoded = borsh.deserialize(
    InitializeMintSchema,
    InitializeMintInstructionData,
    buffer
  );
  return decoded;
}

/**
 * Persist mints to a JSON file
 */
function persistMints() {
  const mintsArray = Array.from(newMints);
  fs.writeFile(MINTS_FILE, JSON.stringify(mintsArray, null, 2), (err) => {
    if (err) {
      console.error('Error saving mints to file:', err);
    } else {
      console.log(`Persisted ${mintsArray.length} mints to ${MINTS_FILE}`);
    }
  });
}

// 4. Create an Express server
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

  try {
    // Initialize lastSlot to the current slot at startup
    const initialSlot = await connection.getSlot();
    lastSlot = initialSlot;
    console.log(`Starting block scanning from slot ${lastSlot}`);
  } catch (err) {
    console.error('Failed to fetch initial slot:', err);
    process.exit(1);
  }

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

      // Calculate the target slot to process
      const targetSlot = currentSlot - SLOT_LAG;

      // Ensure we don't process slots beyond the targetSlot
      if (targetSlot <= lastSlot) {
        // No new slots to process yet
        // Wait and retry in the next poll
        console.log(`No new slots to process. Current slot: ${currentSlot}, last processed: ${lastSlot}`);
      } else {
        // Process slots from lastSlot + 1 up to targetSlot
        for (let slot = lastSlot + 1; slot <= targetSlot; slot++) {
          try {
            // Fetch block with FULL transaction details (needed to decode instructions)
            const block = await connection.getBlock(slot, {
              transactionDetails: 'full',
              maxSupportedTransactionVersion: 0, // only legacy TX if possible
            });

            if (!block) {
              console.log(`Slot ${slot} has no block data. Skipping...`);
              continue; // skip if block is null/unavailable
            }

            console.log(`Processing slot ${slot} with ${block.transactions.length} transactions`);

            // Loop over each transaction in the block
            for (const tx of block.transactions) {
              const { transaction, meta } = tx;
              if (!transaction) {
                console.log(`  Skipping transaction with missing data`);
                continue;             // skip if no transaction object
              }
              if (!transaction.message) {
                console.log(`  Skipping transaction with missing message`);
                continue;             // skip if there's no message
              }

              // Optional: if transaction.version is not undefined and > 0, it's versioned
              if (transaction.version !== undefined && transaction.version > 0) {
                console.log(`  Skipping versioned transaction ${tx.transaction.signatures[0]}`);
                continue; // skip versioned transactions in this demo
              }

              const message = transaction.message;
              if (!message.accountKeys) {
                console.log(`  Skipping transaction with missing accountKeys`);
                continue; // skip if accountKeys is missing
              }

              // Now we can safely parse each instruction
              for (const ix of message.instructions) {
                const programIdIndex = ix.programIdIndex;
                const programId = message.accountKeys[programIdIndex];

                // If the program is the SPL Token Program
                if (programId && programId.equals(TOKEN_PROGRAM_ID)) {
                  console.log(`    Found SPL Token Program instruction`);

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
                      instructionData
                    );
                    // Check if the instruction is indeed InitializeMint
                    if (decoded.instruction === 0) { // 0 is InitializeMint
                      const mintPubkey = new PublicKey(decoded.mintAuthority).toBase58();
                      if (!newMints.has(mintPubkey)) {
                        newMints.add(mintPubkey);
                        console.log(`      Successfully decoded InitializeMint for mint: ${mintPubkey}`);
                        persistMints(); // Persist mints after addition
                      }
                    }
                  } catch (err) {
                    // decodeInitializeMintInstruction throws if it's not actually InitializeMint
                    // or if data is malformed; ignore in that case
                    // Uncomment the line below to see decode errors (optional)
                    // console.log(`      Failed to decode InitializeMint: ${err.message}`);
                  }
                }
              }
            }

            // Update lastSlot to the processed slot
            lastSlot = slot;
          } catch (slotErr) {
            console.error(`Error processing slot ${slot}:`, slotErr);
            // Decide whether to continue or break based on error type
            // For now, continue processing other slots
            continue;
          }
        }
      }
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
