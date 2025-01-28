const express = require('express');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

const app = express();
const port = 5000;
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let newTokens = [];

async function monitorTokenCreations() {
    console.log('Monitoring token creations on devnet...');
    
    const subscriptionId = connection.onSignature(
        async (signatureResult) => {
            try {
                const tx = await connection.getParsedTransaction(
                    signatureResult.signature,
                    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }
                );

                const initializeMintIx = tx.transaction.message.instructions.find(ix => 
                    ix.programId.equals(TOKEN_PROGRAM_ID) &&
                    ix.parsed?.type === 'initializeMint'
                );

                if (initializeMintIx) {
                    const tokenInfo = {
                        signature: signatureResult.signature,
                        mintAddress: initializeMintIx.parsed.info.mint,
                        timestamp: new Date().toLocaleString(),
                        decimals: initializeMintIx.parsed.info.decimals
                    };

                    newTokens.unshift(tokenInfo);
                    console.log('Detected new token:', tokenInfo);
                }
            } catch (error) {
                console.error('Error processing transaction:', error);
            }
        },
        { commitment: 'confirmed' }
    );

    console.log('Active subscription ID:', subscriptionId);
}

monitorTokenCreations();

// Rest of the server code remains the same
app.get('/tokens', (req, res) => res.json(newTokens.slice(0, 50)));
app.use(express.static('public'));
app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));