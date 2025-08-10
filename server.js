// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fileUpload = require('express-fileupload');
const pool = require('./config/db');
const { startReactivationJob } = require('./services/keyService');

// Import Routes
const authRoutes = require('./routes/auth');
const keyRoutes = require('./routes/keys');
const configRoutes = require('./routes/config');
const proxyRoutes = require('./routes/proxy');

const PORT = process.env.PORT || 3000;
const app = express();

// Global Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(fileUpload());
app.use(express.static(path.join(__dirname, 'public')));

// Mount Routers
app.use('/', authRoutes);
app.use('/', keyRoutes);
app.use('/api', configRoutes);
app.use('/v1', proxyRoutes);

// Static HTML serving for root and config page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

// --- Server Startup ---
(async () => {
    try {
        await pool.connect();
        console.log('Successfully connected to Supabase database.');
        
        // Start the automatic key reactivation job
        startReactivationJob();
        
        app.listen(PORT, () => {
          console.log(`AI key proxy server listening on port ${PORT}`);
        });
    } catch (err) {
        console.error('FATAL: Database connection error. Server not started.', err.stack);
    }
})();