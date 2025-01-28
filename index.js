/**
 * index.js
 *
 * A robust Express server that continuously scans the Solana blockchain
 * for newly created SPL token mints by decoding the InitializeMint
 * instruction data. It handles both LEGACY and VERSIONED transactions.
 * 
 * Includes:
 *  - Slot lag to avoid "Block not available" errors
 *  - Borsh-based decoding of InitializeMint
 *  - Persistence of discovered mint addresses in a JSON file
 *  - Basic logs for debugging
 */

const express = require('express');
const {
  Connection,
  clusterApiUrl,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
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
const SLOT_LAG = 2;                       // Number of slots to lag behind to ensure block availability
const MINTS_FILE = path.join(__dirname, 'mints.json'); // File to persist discovered mints
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
        ['instruction', 'u8'], // 0 => InitializeMint in SPL Token
        ['decimals', 'u8'],
        ['mintAuthority', [32]],
        ['freezeAuthorityOption', 'u8'], // 0 or 1
        ['freezeAuthority', [32]],       // Only present if freezeAuthorityOption == 1
      ],
    },
  ],
]);

/**
 * Manually decode InitializeMint instruction data via Borsh
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
 * inspects each transaction's instructions (both legacy & versioned),
 * and decodes SPL Token 'InitializeMint' instructions.
 */
async function pollNewBlocks() {
  while (true) {
    try {
      // Current cluster slot
      const currentSlot = await connection.getSlot();

      // We'll only process up to (currentSlot - SLOT_LAG) to avoid "Block not available"
      const targetSlot = currentSlot - SLOT_LAG;

      if (targetSlot <= lastSlot) {
        // No new slots to process yet
        console.log(`No new slots to process. currentSlot=${currentSlot}, lastSlot=${lastSlot}`);
      } else {
        // Process each slot from (lastSlot + 1) up to targetSlot
        for (let slot = lastSlot + 1; slot <= targetSlot; slot++) {
          try {
            // Fetch block with FULL transaction details
            const block = await connection.getBlock(slot, {
              transactionDetails: 'full',
              // Omit maxSupportedTransactionVersion to allow versioned TX to be returned
            });

            if (!block) {
              console.log(`Slot ${slot} has no block data (null). Skipping...`);
              continue;
            }

            console.log(`Processing slot ${slot} with ${block.transactions.length} transactions`);

            for (const tx of block.transactions) {
              // Each 'tx' has { transaction, meta }
              const { transaction } = tx;
              if (!transaction) {
                console.log(`  Skipping missing transaction object`);
                continue;
              }

              // If there's a version field, it means versioned
              if (transaction.version !== undefined && transaction.version >= 0) {
                // ---------- VERSIONED TRANSACTION PATH ----------
                decodeVersionedTransaction(tx);
              } else {
                // ---------- LEGACY TRANSACTION PATH ----------
                decodeLegacyTransaction(tx);
              }
            }

            // Update lastSlot after fully processing this slot
            lastSlot = slot;

          } catch (slotErr) {
            console.error(`Error processing slot ${slot}:`, slotErr);
            // Continue to next slot
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

/** 
 * decodeVersionedTransaction: 
 * Rebuilds a versioned transaction from the wire format, then 
 * decompiles it to get instructions + accountKeys in legacy form. 
 */
function decodeVersionedTransaction(txInfo) {
  const { transaction } = txInfo;
  try {
    // transaction is a VersionedTransaction instance or similar
    // but for safety we re-serialize and re-deserialize
    const wireTx = transaction.serialize();
    const versionedTx = VersionedTransaction.deserialize(wireTx);

    // Decompile the versioned message to a "legacy-like" format
    const msg = versionedTx.message;
    const legacyFmt = TransactionMessage.decompile(msg);

    // We'll get instructions & accountKeys from the decompiled object
    const instructions = legacyFmt.instructions;
    const accountKeys = legacyFmt.accountKeys;

    // Now parse each instruction
    for (const ix of instructions) {
      if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
        console.log(`    Found SPL Token Program instruction (versioned TX)`);

        // Build a TransactionInstruction-like object
        const instructionData = {
          programId: ix.programId,
          keys: ix.accounts.map((accIndex) => {
            const pubkey = accountKeys[accIndex];
            // We can't easily determine isSigner/isWritable from the decompiled instructions,
            // but for decoding InitializeMint we only need order & data
            return {
              pubkey,
              isSigner: false,
              isWritable: false,
            };
          }),
          data: ix.data,
        };

        try {
          const decoded = decodeInitializeMintInstruction(instructionData);
          if (decoded.instruction === 0) { // 0 => InitializeMint
            // Convert the 32-byte buffer in decoded.mintAuthority to a public key
            const mintPubkey = new PublicKey(decoded.mintAuthority).toBase58();
            if (!newMints.has(mintPubkey)) {
              newMints.add(mintPubkey);
              console.log(`      Successfully decoded InitializeMint (versioned) for mint: ${mintPubkey}`);
              persistMints();
            }
          }
        } catch (err) {
          // Not an InitializeMint or data mismatch
          // console.log(`      decodeInitializeMintInstruction failed: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.log(`  Error decoding versioned transaction: ${err.message}`);
  }
}

/** 
 * decodeLegacyTransaction:
 * The old approach: instructions are in transaction.message.instructions
 * and account keys are in transaction.message.accountKeys
 */
function decodeLegacyTransaction(txInfo) {
  const { transaction } = txInfo;
  const { message } = transaction;
  if (!message || !message.accountKeys) {
    console.log(`  Skipping legacy TX with missing message/accountKeys`);
    return;
  }

  for (const ix of message.instructions) {
    const programIdIndex = ix.programIdIndex;
    const programId = message.accountKeys[programIdIndex];

    if (programId && programId.equals(TOKEN_PROGRAM_ID)) {
      console.log(`    Found SPL Token Program instruction (legacy TX)`);
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

      try {
        const decoded = decodeInitializeMintInstruction(instructionData);
        if (decoded.instruction === 0) { // InitializeMint
          const mintPubkey = new PublicKey(decoded.mintAuthority).toBase58();
          if (!newMints.has(mintPubkey)) {
            newMints.add(mintPubkey);
            console.log(`      Successfully decoded InitializeMint (legacy) for mint: ${mintPubkey}`);
            persistMints();
          }
        }
      } catch (err) {
        // Not an InitializeMint or data mismatch
        // console.log(`      decodeInitializeMintInstruction failed: ${err.message}`);
      }
    }
  }
}

/** Sleep helper */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
