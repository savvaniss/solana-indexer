const express = require('express');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

const app = express();
const port = 5000;
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let newTokens = [];

async function monitorTokenCreations() {
    console.log('Starting enhanced token monitoring...');

    // Method 1: Filtered logs subscription
    const logSubscription = connection.onLogs(
        TOKEN_PROGRAM_ID,
        async ({ logs, signature }) => {
            try {
                if (logs.some(log => log.includes('initializeMint'))) {
                    console.log('Potential token creation detected:', signature);
                    const tx = await connection.getParsedTransaction(signature, {
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0
                    });

                    const initializeIx = tx.transaction.message.instructions.find(ix => 
                        ix.programId.equals(TOKEN_PROGRAM_ID) &&
                        ix.parsed?.type === 'initializeMint'
                    );

                    if (initializeIx) {
                        const tokenInfo = {
                            signature,
                            mintAddress: initializeIx.parsed.info.mint,
                            timestamp: new Date().toLocaleString(),
                            decimals: initializeIx.parsed.info.decimals
                        };
                        newTokens.unshift(tokenInfo);
                        console.log('Confirmed new token:', tokenInfo);
                    }
                }
            } catch (error) {
                console.error('Log processing error:', error.message);
            }
        },
        'confirmed'
    );

    // Method 2: Version-aware transaction polling
    async function pollTransactions() {
        try {
            const signatures = await connection.getSignaturesForAddress(TOKEN_PROGRAM_ID, {
                limit: 10,
                commitment: 'confirmed'
            });
            
            for (const { signature } of signatures) {
                if (!newTokens.some(t => t.signature === signature)) {
                    try {
                        const tx = await connection.getParsedTransaction(signature, {
                            maxSupportedTransactionVersion: 0,
                            commitment: 'confirmed'
                        });

                        const initializeIx = tx.transaction.message.instructions.find(ix => 
                            ix.programId.equals(TOKEN_PROGRAM_ID) &&
                            ix.parsed?.type === 'initializeMint'
                        );
                        
                        if (initializeIx) {
                            const tokenInfo = {
                                signature,
                                mintAddress: initializeIx.parsed.info.mint,
                                timestamp: new Date(tx.blockTime * 1000).toLocaleString(),
                                decimals: initializeIx.parsed.info.decimals
                            };
                            newTokens.unshift(tokenInfo);
                            console.log('Historical token found:', tokenInfo);
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

    // Initial poll and periodic checks
    await pollTransactions();
    setInterval(pollTransactions, 15000);

    console.log('Monitoring initialized with subscription ID:', logSubscription);
}

monitorTokenCreations();

app.get('/tokens', (req, res) => res.json(newTokens.slice(0, 50)));
app.use(express.static('public'));
app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));