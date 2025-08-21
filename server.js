// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fileUpload = 'express-fileupload';
const pool = require('./config/db');
const dotenv = require('dotenv');

// Explicitly initialize services on startup
require('./services/cacheService');
require('./services/statsService'); 

const { startReactivationJob } = require('./services/keyService');

// Import Routes
const authRoutes = require('./routes/auth');
const keyRoutes = require('./routes/keys');
const configRoutes = require('./routes/config');
const proxyRoutes = require('./routes/proxy');
const statsRoutes = require('./routes/stats');
const tooruRoutes = require('./routes/tooru'); // <-- NEW

const PORT = process.env.PORT || 3000;
const app = express();

// Global Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(require('express-fileupload')());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to set provider based on route
const setProvider = (provider) => (req, res, next) => {
    req.provider_from_route = provider;
    next();
};

// Mount Routers
app.use('/', authRoutes);
app.use('/', keyRoutes);
app.use('/api', configRoutes);
app.use('/api', statsRoutes);
app.use('/api/tooru', tooruRoutes); // <-- NEW ADMIN ROUTE

// Add new dedicated route for llm7.io
app.use('/llm7/v1', setProvider('llm7'), proxyRoutes);
// Original generic proxy route
app.use('/v1', proxyRoutes);


// Static HTML serving for root and config page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config.html'));
});
// NEW: Serve the admin panel
app.get('/tooru', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tooru.html'));
});


// --- Server Startup ---
(async () => {
    try {
        await pool.connect();
        console.log('Successfully connected to Supabase database.');
        
        startReactivationJob();
        
        app.listen(PORT, () => {
          console.log(`TooruHub AI Gateway listening on port ${PORT}`);
        });
    } catch (err) {
        console.error('FATAL: Database connection error. Server not started.', err.stack);
    }
})();