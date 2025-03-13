const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = 3000;

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
    const { ssid, password} = req.body;
        // Send the request to the corresponding ESP32 device
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
    const { email, pairingCode } = req.body;

    if (!email || !pairingCode) {
        return res.status(400).json({ error: 'Email and pairing code are required' });
    }

    if (espPairingCodes.includes(String(pairingCode))) {
        try {
            await pool.query(
            `UPDATE pairs 
                SET paired_device = array_append(
                    COALESCE(paired_device, ARRAY[]::varchar[]), 
                    $1
                ) 
                WHERE email = $2`,
                [pairingCode, email]
            );

            res.json({ message: 'Device paired successfully' });
        } catch (error) {
            console.error("Error pairing device:", error);
            res.status(500).json({ error: 'Failed to pair device' });
        }
     
    } else {
        res.status(400).json({ error: 'Invalid pairing code' });
    }
});







let espServoState = {}; // Track servo state for each ESP32

// POST request to set servo state for a specific device
app.post("/servo", async (req, res) => {
  const { pairingCode, state } = req.body; // Expecting pairingCode and state
  try{
  if (state !== "ON" && state !== "OFF") {
    return res.status(400).json({ error: "Invalid state" });
  }

  if (!pairingCode) {
    return res.status(400).json({ error: "Device ID (pairingCode) is required" });
  }

  
  // Set the servo state for the specific device
  espServoState[pairingCode] = state;
  console.log(`Updated state for device ${pairingCode}: ${state}`); 
  res.json({ message: `Servo on device ${pairingCode} set to ${state}` });
  
  }
 catch(error){
   
 }});

// GET request to fetch servo state for a specific device
app.get("/servo", (req, res) => {
  const { pairingCode } = req.query;
  
  if (!pairingCode) {
    return res.status(400).json({ error: "Device ID (pairingCode) is required" });
  }

  // Log received pairingCode
  console.log(`Received GET request for pairingCode: ${pairingCode}`);
  
  const state = espServoState[pairingCode];
  if (!state) {
    return res.status(404).json({ error: "Device not found" });
  }

  res.json({ state });
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

app.get('/get-devices', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Simple query to get paired devices from the pairs table
    const result = await pool.query(
      'SELECT email, paired_device FROM pairs WHERE email = $1',
      [email]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

app.post('/unpair', async (req, res) => {
  try {
    const { device_id, email } = req.body;

    if (!device_id || !email) {
      return res.status(400).json({ 
        success: false,
        error: 'Both device ID and email are required' 
      });
    }

    // Remove specific device from the array
    const result = await pool.query(
      `UPDATE pairs 
       SET paired_device = array_remove(paired_device, $1)
       WHERE email = $2
       AND $1 = ANY(paired_device)
       RETURNING paired_device`,
      [device_id, email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Device not found or already unpaired'
      });
    }

    res.json({
      success: true,
      message: 'Device unpaired successfully',
      remainingDevices: result.rows[0].paired_device || []
    });

  } catch (error) {
    console.error('Unpair error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to unpair device',
      details: error.message
    });
  }
});






// Endpoint to fetch schedules
app.get('/schedules', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM schedules');
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching schedules:', error);
    return res.status(500).json({ error: 'Failed to fetch schedules' });
  }
});


// Track the last state for each pairing code
// Track the last known state to prevent duplicate requests
const lastServoState = {};

const checkAndTriggerServos = async () => {
  try {
    

    // Get the current IST time (HH:MM:SS format)
    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)); // Convert UTC to IST
    const istFormattedTime = istTime.toTimeString().slice(0, 8); // "HH:MM:SS"
    

    // Check database connection
    const testDb = await pool.query('SELECT NOW() AS db_time;');
   

    // Query schedules within a ±2 second range for accuracy
    const { rows: schedules } = await pool.query(
      `
      WITH latest_schedule AS (
        SELECT DISTINCT ON (pairing_code) pairing_code, "  actions", schedule_time
        FROM schedules
        WHERE schedule_time BETWEEN TIMEZONE('Asia/Kolkata', NOW()) - INTERVAL '2 seconds'
                              AND TIMEZONE('Asia/Kolkata', NOW()) + INTERVAL '2 seconds'
        ORDER BY pairing_code, schedule_time DESC
      )
      SELECT pairing_code, "  actions", TO_CHAR(schedule_time AT TIME ZONE 'Asia/Kolkata', 'HH24:MI:SS') AS schedule_time
      FROM latest_schedule;
      `
    );

    if (schedules.length === 0) {
  
      return;
    }

   

    // Process each schedule and trigger the servo
    for (const { pairing_code, "  actions": action, schedule_time } of schedules) {
      // Skip if the action is already performed
      if (lastServoState[pairing_code] === action.toUpperCase()) {
      
        continue;
      }

      console.log(`🚀 Triggering servo for ${pairing_code} to ${action} (Scheduled at ${schedule_time})`);

      // Prepare the payload for /servo
      const payload = {
        pairingCode: pairing_code,
        state: action.toUpperCase(),
      };

     

      // Send the request to the ESP32
      try {
        const response = await fetch('https://pp-kcfa.onrender.com/servo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const responseData = await response.json();
        console.log('✅ ESP32 Response:', responseData);

        // Store the last known state to prevent redundant calls
        lastServoState[pairing_code] = action.toUpperCase();
      } catch (error) {
        console.error(`❌ Error sending request for ${pairing_code}:`, error);
      }
    }
  } catch (error) {
    console.error('❌ Error in checkAndTriggerServos:', error);
  }
};

// Run the schedule checker every 2 seconds
setInterval(checkAndTriggerServos, 2000);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
