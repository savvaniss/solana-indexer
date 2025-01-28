// public/script.js

document.addEventListener('DOMContentLoaded', () => {
    fetchTokens(); // Initial fetch
    // Fetch tokens every 5 seconds
    setInterval(fetchTokens, 5000);
  });
  
  const fetchTokens = async () => {
    try {
      const response = await fetch('/api/tokens');
      const tokens = await response.json();
      updateTable(tokens);
    } catch (error) {
      console.error('Error fetching tokens:', error);
    }
  };
  
  const updateTable = (tokens) => {
    const tableBody = document.getElementById('token-table-body');
    tableBody.innerHTML = ''; // Clear existing rows
  
    tokens.forEach((token, index) => {
      const row = document.createElement('tr');
  
      // Index
      const indexCell = document.createElement('td');
      indexCell.textContent = index + 1;
      row.appendChild(indexCell);
  
      // Token Address
      const addressCell = document.createElement('td');
      addressCell.textContent = token.tokenAddress;
      row.appendChild(addressCell);
  
      // Timestamp
      const timestampCell = document.createElement('td');
      timestampCell.textContent = token.timestamp;
      row.appendChild(timestampCell);
  
      tableBody.appendChild(row);
    });
  };
  