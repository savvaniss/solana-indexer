/**
 * index.js
 *
 * A robust Express server that continuously scans the Solana blockchain
 * for newly created SPL token mints by decoding the InitializeMint
 * instruction data. It handles both LEGACY and VERSIONED transactions,
 * thanks to a high "maxSupportedTransactionVersion" in the Connection config.
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
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// -------------------- CONFIG --------------------
const PORT = 5000;           // Listen on port 5000
const HOST = '0.0.0.0';      // Listen on all interfaces
const SOLANA_CLUSTER = 'devnet'; // 'mainnet-beta' or 'devnet' for testing
const POLL_INTERVAL_MS = 5000;   // How frequently to poll for new slots
const SLOT_LAG = 2;              // Lag behind the current slot to avoid "Block not available"
const MINTS_FILE = path.join(__dirname, 'mints.json'); // file to persist discovered mints

/**
 * 1. Create a Solana connection that supports up to version 10
 *    (meaning we accept v0, v1, v2... up to v10).
 *    This avoids "Transaction version (0) is not supported" errors.
 */
const connection = new Connection(clusterApiUrl(SOLANA_CLUSTER), {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 10,
});

// 2. Track last processed slot and discovered mints
let lastSlot = 0;
const newMints = new Set(); // store unique mint addresses

// Load existing mints from file, if present
if (fs.existsSync(MINTS_FILE)) {
  try {
    const data = fs.readFileSync(MINTS_FILE, 'utf-8');
    const mintsArray = JSON.parse(data);
    mintsArray.forEach((mint) => newMints.add(mint));
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
        ['instruction', 'u8'], // 0 => InitializeMint
        ['decimals', 'u8'],
        ['mintAuthority', [32]],
        ['freezeAuthorityOption', 'u8'],
        ['freezeAuthority', [32]],
      ],
    },
  ],
]);

/**
 * decodeInitializeMintInstruction:
 * Use Borsh to parse SPL Token InitializeMint instructions
 */
function decodeInitializeMintInstruction(instructionData) {
  const buffer = instructionData.data;
  return borsh.deserialize(
    InitializeMintSchema,
    InitializeMintInstructionData,
    buffer
  );
}

/**
 * persistMints:
 * Writes all discovered mints to mints.json
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

// 4. Create an Express server + serve front-end
const app = express();
app.use(express.static('public'));

// REST endpoint: GET /api/mints
app.get('/api/mints', (req, res) => {
  return res.json(Array.from(newMints));
});

// Start listening
app.listen(PORT, HOST, async () => {
  console.log(`\nSolana Mint Indexer is running on http://${HOST}:${PORT}...`);

  try {
    // Initialize lastSlot to the current slot
    lastSlot = await connection.getSlot();
    console.log(`Starting block scanning from slot ${lastSlot}`);
  } catch (err) {
    console.error('Failed to fetch initial slot:', err);
    process.exit(1);
  }

  // Begin the polling loop
  pollNewBlocks();
});

/**
 * pollNewBlocks:
 * Continuously fetches blocks above the last processed slot,
 * inspects each transaction for SPL Token InitializeMint instructions,
 * and records new minted addresses.
 */
async function pollNewBlocks() {
  while (true) {
    try {
      const currentSlot = await connection.getSlot();
      const targetSlot = currentSlot - SLOT_LAG;

      if (targetSlot <= lastSlot) {
        // no new slots
        console.log(`No new slots to process. currentSlot=${currentSlot}, lastSlot=${lastSlot}`);
      } else {
        // Process each slot from (lastSlot+1) up to targetSlot
        for (let slot = lastSlot + 1; slot <= targetSlot; slot++) {
          try {
            // We do NOT specify maxSupportedTransactionVersion here,
            // because we set it in the Connection constructor above.
            const block = await connection.getBlock(slot, {
              transactionDetails: 'full',
            });

            if (!block) {
              console.log(`Slot ${slot} has no block data (null). Skipping...`);
              continue;
            }

            console.log(`Processing slot ${slot} with ${block.transactions.length} transactions`);

            for (const tx of block.transactions) {
              const { transaction } = tx;
              if (!transaction) {
                console.log(`  Skipping missing transaction object`);
                continue;
              }

              // If "transaction.version" is a number => versioned TX
              if (transaction.version !== undefined && transaction.version >= 0) {
                decodeVersionedTransaction(tx);
              } else {
                decodeLegacyTransaction(tx);
              }
            }

            lastSlot = slot; // we've processed this slot
          } catch (slotErr) {
            console.error(`Error processing slot ${slot}:`, slotErr);
            continue;
          }
        }
      }
    } catch (err) {
      console.error('Error in pollNewBlocks loop:', err);
    }

    // Wait before polling again
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * decodeVersionedTransaction:
 * For a versioned transaction, re-serialize/deserialize to a VersionedTransaction,
 * then use TransactionMessage.decompile() to get instructions + accountKeys
 * in "legacy-like" form.
 */
function decodeVersionedTransaction(txInfo) {
  const { transaction } = txInfo;
  try {
    // (Re)serialize the transaction for safety
    const wireTx = transaction.serialize();
    const versionedTx = VersionedTransaction.deserialize(wireTx);

    const msg = versionedTx.message;
    const legacyFmt = TransactionMessage.decompile(msg);

    const instructions = legacyFmt.instructions;
    const accountKeys = legacyFmt.accountKeys;

    for (const ix of instructions) {
      if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
        console.log(`    Found SPL Token Program instruction (versioned TX)`);

        // Build a pseudo-TransactionInstruction
        const ixData = {
          programId: ix.programId,
          keys: ix.accounts.map((idx) => {
            const pubkey = accountKeys[idx];
            return { pubkey, isSigner: false, isWritable: false };
          }),
          data: ix.data,
        };

        try {
          const decoded = decodeInitializeMintInstruction(ixData);
          if (decoded.instruction === 0) {
            const mint = new PublicKey(decoded.mintAuthority).toBase58();
            if (!newMints.has(mint)) {
              newMints.add(mint);
              console.log(`      Decoded InitializeMint (versioned) for mint: ${mint}`);
              persistMints();
            }
          }
        } catch (err) {
          // Not an InitializeMint or parse error
        }
      }
    }
  } catch (err) {
    console.log(`  Error decoding versioned transaction: ${err.message}`);
  }
}

/**
 * decodeLegacyTransaction:
 * The standard approach for older, no-version transactions.
 */
function decodeLegacyTransaction(txInfo) {
  const { transaction } = txInfo;
  const { message } = transaction;
  if (!message?.accountKeys) {
    console.log(`  Skipping legacy TX with missing message/accountKeys`);
    return;
  }

  for (const ix of message.instructions) {
    const programIdIndex = ix.programIdIndex;
    const programId = message.accountKeys[programIdIndex];
    if (programId && programId.equals(TOKEN_PROGRAM_ID)) {
      console.log(`    Found SPL Token Program instruction (legacy TX)`);

      const ixData = {
        programId,
        keys: ix.accounts.map((accIndex) => ({
          pubkey: message.accountKeys[accIndex],
          isSigner: message.isAccountSigner(accIndex),
          isWritable: message.isAccountWritable(accIndex),
        })),
        data: Buffer.from(ix.data, 'base64'),
      };

      try {
        const decoded = decodeInitializeMintInstruction(ixData);
        if (decoded.instruction === 0) {
          const mint = new PublicKey(decoded.mintAuthority).toBase58();
          if (!newMints.has(mint)) {
            newMints.add(mint);
            console.log(`      Decoded InitializeMint (legacy) for mint: ${mint}`);
            persistMints();
          }
        }
      } catch (err) {
        // Not an InitializeMint
      }
    }
  }
}

/** Sleep helper */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
