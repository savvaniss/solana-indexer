const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');

const app = express();
const port = 5000;

app.use(cors());
app.use(bodyParser.json());

// Connect to Solana devnet
const connection = new Connection('https://api.devnet.solana.com');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

let newTokens = [];

async function monitorTokens() {
    connection.onLogs('all', async ({ logs, signature }) => {
        if (logs.some(log => log.includes('initializeMint'))) {
            const transaction = await connection.getParsedTransaction(signature);
            const mintAccount = transaction.transaction.message.instructions
                .find(ix => ix.programId.equals(TOKEN_PROGRAM_ID))
                .accounts[0];
            
            const tokenInfo = {
                signature,
                mintAddress: mintAccount.toBase58(),
                timestamp: new Date().toLocaleString(),
            };
            
            newTokens.unshift(tokenInfo);
            console.log('New token detected:', tokenInfo);
        }
    });
}

monitorTokens();

// API endpoint to get tokens
app.get('/tokens', (req, res) => {
    res.json(newTokens.slice(0, 50)); // Return last 50 tokens
});

// Serve static files
app.use(express.static('public'));

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${port}`);
});