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
pool.connect()
    .then(() => console.log("✅ Connected to Neon PostgreSQL Database"))
    .catch(err => console.error("❌ Database Connection Error:", err));

const SECRET_KEY = '/cTFigjrKOOlRA7S1bI1Pxk809ZAN4gi5FJ3gmc4jKcQjfJST27NeZv6n8OJP6sU0+N7JJUAkc+DdsXwOIkQaw=='; // Use a secure key

// Routes
app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
        await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hashedPassword]);
        res.status(201).send({ message: 'User registered successfully' });
    } catch (err) {
        res.status(400).send({ error: 'Registration failed' });
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


let espPairingCode = null; // Stores the latest pairing code from ESP32

// ESP32 sends pairing code
app.post("/get-pairing-code", (req, res) => {
    espPairingCode = req.body.pair_code;
    console.log("Received ESP32 Pairing Code:", espPairingCode);
    res.json({ message: "Pairing code received" });
});

// Website sends pairing code for validation
app.post("/validate", (req, res) => {
    const userCode = req.body.user_code;

    if (!espPairingCode) {
        return res.json({ status: "error", message: "No ESP32 code received yet" });
    }

    if (userCode === espPairingCode) {
        res.json({ status: "valid" });
    } else {
        res.json({ status: "invalid" });
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});


