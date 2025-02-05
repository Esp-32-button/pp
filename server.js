const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = 3000;
const ESP32_IP = 'http://192.168.132.56';
app.use(bodyParser.json());
app.use(cors());


// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Function to connect to the database and handle errors
function connectToDatabase() {
  pool.connect()
    .then(client => {
      console.log("✅ Connected to Neon PostgreSQL Database");
      // Optionally handle the client connection here if needed
      client.release(); // Make sure to release the client back to the pool
    })
    .catch(err => {
      console.error("❌ Database Connection Error:", err);
      // Retry connection after 5 seconds
      setTimeout(connectToDatabase, 5000);
    });
}

// Handle pool errors
pool.on('error', (err, client) => {
  console.error('PostgreSQL pool error:', err);
  // Optionally, you can attempt to reconnect or log additional details.
  // Retrying the connection could be handled here as well if necessary.
  setTimeout(connectToDatabase, 5000);  // Retry connection if pool error occurs
});

// Initial connection attempt
connectToDatabase();

// Handle client-specific errors (this is the main issue)
pool.on('connect', client => {
  client.on('error', (err) => {
    console.error('PostgreSQL client error:', err);
    // Optionally, you can implement retry logic here if necessary
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, closing PostgreSQL connection...');
  pool.end();  // Close the pool gracefully
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, closing PostgreSQL connection...');
  pool.end();  // Close the pool gracefully
  process.exit(0);
});

const SECRET_KEY = '/cTFigjrKOOlRA7S1bI1Pxk809ZAN4gi5FJ3gmc4jKcQjfJST27NeZv6n8OJP6sU0+N7JJUAkc+DdsXwOIkQaw=='; // Use a secure key

// Routes
app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    try {
        // Insert user into users table
        await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hashedPassword]);

        // Insert email into pairs table with paired_device set to NULL
        await pool.query('INSERT INTO pairs (email, paired_device) VALUES ($1, NULL)', [email]);

        res.status(201).send({ message: 'User registered successfully' });
    } catch (err) {
        console.error('Error during registration:', err);
        res.status(400).send({ error: 'Registration failed', details: err.message });
    }
});




app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (!result.rows.length) return res.status(404).send({ error: 'User not found' });

        const user = result.rows[0];
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return res.status(401).send({ error: 'Invalid credentials' });

        const token = jwt.sign({ userId: user.id }, SECRET_KEY);
        res.status(200).send({ token });
    } catch (err) {
        res.status(400).send({ error: 'Login failed' });
    }
});




app.post('/wifi', (req, res) => {
    const { ssid, password } = req.body;

    // Forward the request to the ESP32
    const espUrl = `http://<ESP32-IP-Address>/change_wifi`;
    fetch(espUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ssid, password }),
    })
        .then((response) => response.text())
        .then((data) => res.status(200).send({ message: data }))
        .catch((error) => res.status(500).send({ error: 'Failed to update Wi-Fi credentials' }));
});


let espPairingCodes = []; // Array to store multiple pairing codes
let espLastSeen = {}; // Object to store the last time each pairing code was seen

// Helper function to remove stale pairing codes after a timeout
function removeStalePairingCodes() {
    const timeout = 20000; // Timeout in milliseconds (e.g., 1 minute)
    const currentTime = Date.now();

    for (let code in espLastSeen) {
        if (currentTime - espLastSeen[code] > timeout) {
            console.log(`Removing stale pairing code: ${code}`);
            espPairingCodes = espPairingCodes.filter(pairingCode => pairingCode !== code);
            delete espLastSeen[code];
        }
    }
}

// ESP32 sends pairing code
app.post("/get-pairing-code", (req, res) => {
  const newPairingCode = req.body.pair_code;
  
  // Store the received pairing code in the array
  espPairingCodes.push(newPairingCode);
  espLastSeen[newPairingCode] = Date.now(); // Track when the code was received

  console.log("Received ESP32 Pairing Code:", newPairingCode);
  console.log("Current Pairing Codes Array:", espPairingCodes);  // Log the array to verify it's storing the codes
  
  res.json({ message: "Pairing code received" });
});



// ESP32 sends heartbeat
app.post("/heartbeat", (req, res) => {
    const pairCode = req.body.pair_code;
    if (espPairingCodes.includes(pairCode)) {
        espLastSeen[pairCode] = Date.now(); // Update the last seen time
        console.log(`Heartbeat received for pairing code: ${pairCode}`);
    } else {
        console.log(`Unknown pairing code received: ${pairCode}`);
    }
    res.json({ message: "Heartbeat received" });
});

// Periodically check for stale codes
setInterval(removeStalePairingCodes, 20000); // Check every minute

// Website sends pairing code for validation


app.post("/validate", async (req, res) => {
    console.log("Request body:", req.body);  // Log the incoming request for debugging

    const userCode = req.body.user_code;
    const email = req.body.email; // Assuming you are passing email with the request

    // Ensure espPairingCodes is an array
    if (!Array.isArray(espPairingCodes)) {
        return res.json({ status: "error", message: "Internal server error: Pairing codes array is not properly initialized" });
    }

    // Check if userCode is provided
    if (!userCode) {
        return res.json({ status: "error", message: "User code not provided" });
    }

    // Check if there are any pairing codes received yet
    if (espPairingCodes.length === 0) {
        return res.json({ status: "error", message: "No ESP32 codes received yet" });
    }

    // Check if the userCode exists in the array of pairing codes
    if (espPairingCodes.includes(String(userCode))) {
        try {
            // Update the paired_device column in the pairs table for the user
            await pool.query('UPDATE pairs SET paired_device = $1 WHERE email = $2', [userCode, email]);

            res.json({ status: "valid", message: "Pairing code added successfully" });
        } catch (error) {
            console.error("Error inserting pairing code:", error);
            res.json({ status: "error", message: "Failed to add pairing code", details: error.message });
        }
    } else {
        res.json({ status: "invalid", message: "Invalid pairing code" });
    }
});




app.post('/change_wifi', async (req, res) => {
    const { ssid, password } = req.body;

    if (!ssid || !password) {
        return res.status(400).json({ error: 'SSID and Password are required.' });
    }

    try {
        const response = await axios.post('http://<ESP32_IP_ADDRESS>/change_wifi', {
            ssid,
            password,
        });

        if (response.status === 200) {
            res.json({ message: 'Wi-Fi information updated successfully.' });
        } else {
            res.status(500).json({ error: 'Failed to update Wi-Fi on the ESP32.' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error communicating with ESP32.' });
    }
});

let servoState = "OFF"; // Default state

app.post("/servo", (req, res) => {
  const { state } = req.body;
  if (state !== "ON" && state !== "OFF") return res.status(400).json({ error: "Invalid state" });

  servoState = state;
  res.json({ message: `Servo set to ${state}` });
});

// ESP32 Fetches State
app.get("/servo", (req, res) => {
  res.json({ state: servoState });
});

app.post('/add-pairing-code', async (req, res) => {
    const { email, pairingCode } = req.body;

    // Ensure both email and pairingCode are provided
    if (!email || !pairingCode) {
        return res.status(400).send({ error: 'Email and pairing code are required' });
    }

    // Create the device JSON object
    const deviceData = {
        pairingCode: pairingCode
        
    };

    try {
        // Update the user's device column with a valid JSON string
        await pool.query(
            'UPDATE users SET device = $1 WHERE email = $2',
            [JSON.stringify(deviceData), email]  // Ensure JSON object is passed as a string
        );

        res.status(200).send({ message: 'Pairing code added successfully' });
    } catch (err) {
        console.error('Error adding pairing code:', err);
        res.status(400).send({ error: 'Failed to add pairing code' });
    }
});


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});


