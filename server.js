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
                // Detect token initialization logs
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
                                    timestamp: new Date(tx.blockTime * 1000).toLocaleString(),
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

// Endpoint to fetch the latest 50 tokens
app.get('/tokens', (req, res) => res.json(newTokens.slice(0, 50)));

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Start the Express server
app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
