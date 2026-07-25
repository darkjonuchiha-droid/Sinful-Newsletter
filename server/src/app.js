'use strict';
const path = require('node:path');
const express = require('express');
const storage = require('./storage');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// Hold requests until the storage driver has initialized (matters for the
// Postgres path and for serverless cold starts).
app.use((req, res, next) => { storage.ready.then(() => next(), next); });

const adminApi = require('./admin-api');
const kioskApi = require('./kiosk-api');
const publicRoutes = require('./public-routes');

app.use(publicRoutes.router); // /u/... unsubscribe links (no auth)
app.use('/api/kiosk', kioskApi.router);
app.use('/api', adminApi.router);

app.use(express.static(path.join(__dirname, '..', 'public')));

// JSON error handler (malformed bodies, DB failures, etc.)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'server error' });
});

module.exports = app;
