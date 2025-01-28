const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

const app = express();
const port = 5000;

app.use(cors());
app.use(bodyParser.json());

// Connect to Solana devnet with explicit configuration
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let newTokens = [];

async function monitorTokens() {
    console.log('Starting Solana devnet monitoring...');
    
    try {
        const subscriptionId = connection.onLogs(
            'all',
            async ({ logs, signature }) => {
                try {
                    if (logs.some(log => log.includes('initializeMint'))) {
                        console.log('Found initializeMint log, processing...');
                        const tx = await connection.getConfirmedTransaction(signature);
                        
                        // Find the initializeMint instruction
                        const initializeIx = tx.transaction.message.instructions.find(ix => 
                            ix.programId.toString() === TOKEN_PROGRAM_ID.toString() &&
                            ix.parsed.type === 'initializeMint'
                        );

                        if (initializeIx) {
                            const mintAddress = initializeIx.parsed.info.mint;
                            const tokenInfo = {
                                signature,
                                mintAddress,
                                timestamp: new Date().toLocaleString(),
                            };
                            
                            newTokens.unshift(tokenInfo);
                            console.log('New token detected:', tokenInfo);
                        }
                    }
                } catch (error) {
                    console.error('Error processing transaction:', error);
                }
            },
            'confirmed'
        );
        
        console.log('Subscription active with ID:', subscriptionId);
    } catch (error) {
        console.error('Connection error:', error);
    }
}

monitorTokens();

// API endpoint to get tokens
app.get('/tokens', (req, res) => {
    res.json(newTokens.slice(0, 50));
});

app.use(express.static('public'));

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${port}`);
});