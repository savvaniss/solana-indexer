// server.js

const express = require('express');
const cors = require('cors');
const { Connection, clusterApiUrl, PublicKey } = require('@solana/web3.js');

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.static('public'));

// Initialize Solana connection to devnet
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

// Store discovered tokens
let tokens = [];

// Function to fetch existing tokens at startup
const fetchExistingTokens = async () => {
  console.log('Fetching existing tokens...');
  // Note: Solana doesn't have a straightforward API to list all tokens.
  // This requires indexing or using external services.
  // For demonstration, we'll skip fetching existing tokens.
};

// Function to monitor for new token creations
const monitorNewTokens = async () => {
  console.log('Monitoring for new tokens on Solana devnet...');

  // SPL Token program ID
  const SPL_TOKEN_PROGRAM_ID = new PublicKey(
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  );

  // Subscribe to all program accounts for SPL Token
  connection.onProgramAccountChange(
    SPL_TOKEN_PROGRAM_ID,
    (publicKey, accountInfo, context) => {
      // Ensure that the publicKey is defined
      if (!publicKey) {
        console.error('Received undefined publicKey');
        return;
      }

      const tokenAddress = publicKey.toBase58();
      const timestamp = new Date().toLocaleString();
      const newToken = { tokenAddress, timestamp };
      tokens.unshift(newToken); // Add to the beginning
      console.log(`New Token Detected: ${tokenAddress} at ${timestamp}`);
    },
    'confirmed'
  );
};

// API endpoint to get the list of tokens
app.get('/api/tokens', (req, res) => {
  res.json(tokens);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  fetchExistingTokens();
  monitorNewTokens();
});
