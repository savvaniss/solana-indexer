const express = require('express');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

const app = express();
const port = 5000;
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let newTokens = [];

async function monitorTokenCreations() {
    console.log('Starting token monitoring...');
    
    // Method 1: Logs subscription
    const logSubscription = connection.onLogs(
        TOKEN_PROGRAM_ID,
        async ({ logs, signature }) => {
            try {
                console.log('Received logs:', logs);
                if (logs.some(log => log.includes('initializeMint'))) {
                    console.log('Found initializeMint in logs');
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
                        console.log('New token detected via logs:', tokenInfo);
                    }
                }
            } catch (error) {
                console.error('Log processing error:', error);
            }
        },
        'confirmed'
    );

    // Method 2: Poll recent transactions
    async function pollTransactions() {
        try {
            const signatures = await connection.getSignaturesForAddress(TOKEN_PROGRAM_ID);
            for (const { signature } of signatures) {
                if (!newTokens.some(t => t.signature === signature)) {
                    const tx = await connection.getParsedTransaction(signature);
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
                }
            }
        } catch (error) {
            console.error('Polling error:', error);
        }
    }

    // Initial poll and periodic checks
    await pollTransactions();
    setInterval(pollTransactions, 30000);

    console.log('Log subscription ID:', logSubscription);
}

monitorTokenCreations();

app.get('/tokens', (req, res) => res.json(newTokens.slice(0, 50)));
app.use(express.static('public'));
app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));