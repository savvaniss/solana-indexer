const express = require('express');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

const app = express();
const port = 5000;
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let newTokens = [];

async function monitorTokenCreations() {
    console.log('Monitoring token program logs...');
    
    const subscriptionId = connection.onLogs(
        TOKEN_PROGRAM_ID,
        async ({ logs, signature }) => {
            try {
                if (logs.some(log => log.includes('initializeMint'))) {
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
                        console.log('New token detected:', tokenInfo);
                    }
                }
            } catch (error) {
                console.error('Error processing logs:', error);
            }
        },
        'confirmed'
    );

    console.log('Active subscription ID:', subscriptionId);
}

monitorTokenCreations();

// Rest of the server code remains the same
app.get('/tokens', (req, res) => res.json(newTokens.slice(0, 50)));
app.use(express.static('public'));
app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));