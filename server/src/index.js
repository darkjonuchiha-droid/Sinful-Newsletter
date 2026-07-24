'use strict';
const path = require('node:path');
const express = require('express');
const config = require('./config');
require('./db'); // initialize schema

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

const adminApi = require('./admin-api');
const kioskApi = require('./kiosk-api');

app.use('/api/kiosk', kioskApi.router);
app.use('/api', adminApi.router);

app.use(express.static(path.join(__dirname, '..', 'public')));

// JSON error handler (malformed bodies, etc.)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'server error' });
});

app.listen(config.port, () => {
  console.log(`Sinful Newsletter Hub on http://localhost:${config.port}`);
});
