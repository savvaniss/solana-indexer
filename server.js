// server.js
const express = require('express');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

const app = express();
const port = 5000;

// Initialize Solana connection to Devnet
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

// Token Program ID for SPL Tokens
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Array to store new token information
let newTokens = [];

/**
 * Function to monitor token creations using two methods:
 * 1. Subscribing to program logs
 * 2. Polling recent transactions
 */
async function monitorTokenCreations() {
    console.log('Starting enhanced token monitoring...');

    // Method 1: Subscribe to logs for the Token Program
    const logSubscription = connection.onLogs(
        TOKEN_PROGRAM_ID,
        async ({ logs, signature }) => {
            try {
                if (logs.some(log => log.includes('initializeMint'))) {
                    console.log('Potential token creation detected:', signature);

                    // Fetch the parsed transaction details
                    const tx = await connection.getParsedTransaction(signature, {
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0
                    });

                    if (tx) {
                        // Find the initializeMint instruction
                        const initializeIx = tx.transaction.message.instructions.find(ix =>
                            ix.programId.equals(TOKEN_PROGRAM_ID) &&
                            ix.parsed?.type === 'initializeMint'
                        );

                        if (initializeIx) {
                            const mintAddress = initializeIx.parsed.info.mint;
                            // Fetch mint account info to get total supply and authorities
                            const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress), 'confirmed');
                            const mintData = mintInfo.value?.data?.parsed?.info;

                            const tokenInfo = {
                                signature,
                                mintAddress: mintAddress,
                                timestamp: new Date().toLocaleString(),
                                decimals: initializeIx.parsed.info.decimals,
                                totalSupply: mintData?.supply || 'N/A',
                                mintAuthority: mintData?.mintAuthority?.address || 'N/A',
                                freezeAuthority: mintData?.freezeAuthority?.address || 'None',
                                explorerLink: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
                            };

                            // Add the new token to the beginning of the array
                            newTokens.unshift(tokenInfo);
                            console.log('Confirmed new token:', tokenInfo);
                        }
                    }
                }
            } catch (error) {
                console.error('Log processing error:', error.message);
            }
        },
        'confirmed'
    );

    // Method 2: Poll recent transactions for historical token creations
    async function pollTransactions() {
        try {
            const signatures = await connection.getSignaturesForAddress(TOKEN_PROGRAM_ID, {
                limit: 10,
                commitment: 'confirmed'
            });

            for (const { signature } of signatures) {
                // Skip if already processed
                if (!newTokens.some(t => t.signature === signature)) {
                    try {
                        const tx = await connection.getParsedTransaction(signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment: 'confirmed'
                        });

                        if (tx) {
                            // Find the initializeMint instruction
                            const initializeIx = tx.transaction.message.instructions.find(ix =>
                                ix.programId.equals(TOKEN_PROGRAM_ID) &&
                                ix.parsed?.type === 'initializeMint'
                            );

                            if (initializeIx) {
                                const mintAddress = initializeIx.parsed.info.mint;
                                // Fetch mint account info
                                const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress), 'confirmed');
                                const mintData = mintInfo.value?.data?.parsed?.info;

                                const tokenInfo = {
                                    signature,
                                    mintAddress: mintAddress,
                                    // blockTime is in seconds; convert to ms
                                    timestamp: tx.blockTime 
                                      ? new Date(tx.blockTime * 1000).toLocaleString()
                                      : new Date().toLocaleString(),
                                    decimals: initializeIx.parsed.info.decimals,
                                    totalSupply: mintData?.supply || 'N/A',
                                    mintAuthority: mintData?.mintAuthority?.address || 'N/A',
                                    freezeAuthority: mintData?.freezeAuthority?.address || 'None',
                                    explorerLink: `https://explorer.solana.com/tx/${signature}?cluster=devnet`
                                };

                                newTokens.unshift(tokenInfo);
                                console.log('Historical token found:', tokenInfo);
                            }
                        }
                    } catch (error) {
                        console.error('Transaction processing error:', error.message);
                    }
                }
            }
        } catch (error) {
            console.error('Polling error:', error.message);
        }
    }

    // Initial poll and set interval for polling every 15 seconds
    await pollTransactions();
    setInterval(pollTransactions, 15000);

    console.log('Monitoring initialized with subscription ID:', logSubscription);
}

// Start monitoring token creations
monitorTokenCreations();

/**
 * Helper function to sort tokens based on the 'sort' query param
 */
function sortTokens(tokens, sortBy) {
    switch (sortBy) {
        case 'oldest':
            return tokens.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        case 'alphabetical':
            // We'll assume "alphabetical" means sorting by mintAddress
            return tokens.sort((a, b) => a.mintAddress.localeCompare(b.mintAddress));
        case 'supply':
            return tokens.sort((a, b) => parseInt(b.totalSupply) - parseInt(a.totalSupply));
        case 'newest':
        default:
            return tokens.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
}

/**
 * Endpoint to fetch paginated & sorted tokens
 * Query Params:
 *   - page: current page (default = 1)
 *   - limit: number of tokens per page (default = 10)
 *   - sort: sorting strategy ('newest', 'oldest', 'alphabetical', 'supply')
 */
app.get('/tokens', (req, res) => {
    const { page = 1, limit = 10, sort = 'newest' } = req.query;

    // Convert to integers and handle corner cases
    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(limit, 10) || 10, 1);

    // Sort tokens
    let sorted = sortTokens([...newTokens], sort);

    // Calculate total tokens
    const total = sorted.length;

    // Calculate start and end indices for slicing
    const startIndex = (pageNumber - 1) * pageSize;
    const endIndex = startIndex + pageSize;

    // Slice tokens for this page
    const tokensForPage = sorted.slice(startIndex, endIndex);

    // Return paginated data
    res.json({
        total,
        page: pageNumber,
        pageSize,
        tokens: tokensForPage
    });
});

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Start the Express server
app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
