// server.js

const express = require('express');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

// If running on Node < 18, uncomment and install node-fetch:
// const fetch = require('node-fetch');

const app = express();
const port = 5000;

// Initialize Solana connection to Mainnet
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// Token Program ID for SPL Tokens
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Array to store new token information
let newTokens = [];

/**
 * Check if the given mint is listed on Raydium, and retrieve liquidity (if available).
 */
async function checkRaydium(mintAddress) {
    let listedOnRaydium = false;
    let liquidity = 0;
    try {
        const resp = await fetch('https://api.raydium.io/v2/main/pairs');
        const data = await resp.json();
        // Each element is an object with baseMint, quoteMint, liquidity, etc.
        for (const pair of data) {
            if (pair.baseMint === mintAddress || pair.quoteMint === mintAddress) {
                listedOnRaydium = true;
                // Raydium sometimes returns liquidity as a number. If not found, default to 0
                liquidity = pair.liquidity || 0;
                break;
            }
        }
    } catch (error) {
        console.error('Raydium fetch error:', error);
    }
    return { listedOnRaydium, liquidity };
}

/**
 * Check if the given mint is listed on Orca, and retrieve liquidity (if available).
 */
async function checkOrca(mintAddress) {
    let listedOnOrca = false;
    let liquidity = 0;
    try {
        // Orca's pool data endpoint
        const resp = await fetch('https://api.orca.so/v1/allPools');
        const data = await resp.json();
        // data is an object: poolId => { tokenMintA, tokenMintB, liquidity, ... }
        for (const [poolId, poolInfo] of Object.entries(data)) {
            if (
                poolInfo.tokenMintA === mintAddress ||
                poolInfo.tokenMintB === mintAddress
            ) {
                listedOnOrca = true;
                // If Orca provides a 'liquidity' field, use it. Otherwise fallback to 0
                liquidity = poolInfo.liquidity || 0;
                break;
            }
        }
    } catch (error) {
        console.error('Orca fetch error:', error);
    }
    return { listedOnOrca, liquidity };
}

/**
 * For a newly identified mint, check both DEXes asynchronously and attach the info.
 */
async function checkDexListings(tokenInfo) {
    const { mintAddress } = tokenInfo;
    // Raydium + Orca checks in parallel
    const [raydiumRes, orcaRes] = await Promise.all([
        checkRaydium(mintAddress),
        checkOrca(mintAddress)
    ]);

    tokenInfo.listedOnRaydium = raydiumRes.listedOnRaydium;
    tokenInfo.raydiumLiquidity = raydiumRes.liquidity;
    tokenInfo.listedOnOrca = orcaRes.listedOnOrca;
    tokenInfo.orcaLiquidity = orcaRes.liquidity;
}

/**
 * Fetch transaction details and push to newTokens array
 */
async function processNewTokenTx(signature) {
    try {
        // Skip if we already processed it
        if (newTokens.some(t => t.signature === signature)) {
            return;
        }

        const tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (tx && tx.meta) {
            // Find the initializeMint instruction
            const initializeIx = tx.transaction.message.instructions.find(
                ix => 
                    ix.programId.equals(TOKEN_PROGRAM_ID) &&
                    ix.parsed?.type === 'initializeMint'
            );

            if (initializeIx) {
                const mintAddress = initializeIx.parsed.info.mint;
                
                // Fetch mint account info
                const mintInfo = await connection.getParsedAccountInfo(
                    new PublicKey(mintAddress),
                    'confirmed'
                );
                const mintData = mintInfo.value?.data?.parsed?.info;

                // Construct tokenInfo
                // blockTime is in seconds, so convert to ms
                const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();
                const tokenInfo = {
                    signature,
                    mintAddress,
                    timestamp: blockTime.toLocaleString(),
                    decimals: initializeIx.parsed.info.decimals,
                    totalSupply: mintData?.supply || 'N/A',
                    mintAuthority: mintData?.mintAuthority?.address || 'N/A',
                    freezeAuthority: mintData?.freezeAuthority?.address || 'None',
                    explorerLink: `https://explorer.solana.com/tx/${signature}`, // mainnet by default
                    // Optional placeholders for DEX listing; will fill below
                    listedOnRaydium: false,
                    listedOnOrca: false,
                    raydiumLiquidity: 0,
                    orcaLiquidity: 0
                };

                // Check Raydium & Orca
                await checkDexListings(tokenInfo);

                // Push to the start of newTokens
                newTokens.unshift(tokenInfo);
                console.log('New token processed:', tokenInfo);
            }
        }
    } catch (error) {
        console.error('Transaction processing error:', error.message);
    }
}

/**
 * Method 1: Subscribe to Program Logs for real-time detection
 */
function subscribeToTokenProgram() {
    connection.onLogs(
        TOKEN_PROGRAM_ID,
        async ({ logs, signature }) => {
            try {
                // Detect token initialization logs
                if (logs.some(log => log.includes('initializeMint'))) {
                    console.log('Potential token creation detected:', signature);
                    await processNewTokenTx(signature);
                }
            } catch (error) {
                console.error('Log processing error:', error.message);
            }
        },
        'confirmed'
    );
}

/**
 * Method 2: Periodically poll recent transactions
 */
async function pollRecentTransactions() {
    try {
        const signatures = await connection.getSignaturesForAddress(
            TOKEN_PROGRAM_ID,
            { limit: 10, commitment: 'confirmed' }
        );
        
        for (const { signature } of signatures) {
            await processNewTokenTx(signature);
        }
    } catch (error) {
        console.error('Polling error:', error.message);
    }
}

async function monitorTokenCreations() {
    console.log('Starting token monitoring on mainnet...');

    // 1) Subscribe to program logs (real-time)
    subscribeToTokenProgram();

    // 2) Poll for recent transactions every 10 seconds
    await pollRecentTransactions();
    setInterval(pollRecentTransactions, 10000);

    console.log('Monitoring initialized...');
}

// Start monitoring token creations
monitorTokenCreations();

// Endpoint to fetch the latest 50 tokens
app.get('/tokens', (req, res) => {
    // If desired, you can also attach any known name/symbol from a token list here,
    // but typically the front-end fetches it. This is purely the raw server approach.
    res.json(newTokens.slice(0, 50));
});

// Serve static files (your index.html) from the 'public' directory
// Make sure you place your updated index.html in the "public" folder or adjust accordingly.
app.use(express.static('public'));

// Start the Express server
app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
