'use strict';
// Self-hosted entry point. (Vercel uses api/index.js instead.)
const config = require('./config');
const app = require('./app');

app.listen(config.port, () => {
  console.log(`Sinful Newsletter Hub on http://localhost:${config.port}`
    + (config.databaseUrl ? ' (Postgres)' : ' (SQLite)'));
});
