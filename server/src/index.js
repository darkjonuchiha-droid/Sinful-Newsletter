'use strict';
// Self-hosted entry point. (Vercel uses api/index.js instead.)
const config = require('./config');
const app = require('./app');
const { fireDueSchedules, pingKiosk } = require('./kiosk-api');

app.listen(config.port, () => {
  console.log(`Sinful Newsletter Hub on http://localhost:${config.port}`
    + (config.databaseUrl ? ' (Postgres)' : ' (SQLite)'));
});

// Self-hosted scheduler tick. (On serverless, the kiosk heartbeat and the
// dashboard act as the clock instead — see fireDueSchedules call sites.)
setInterval(async () => {
  try {
    if (await fireDueSchedules() > 0) await pingKiosk();
  } catch (e) { console.error('scheduler tick:', e.message); }
}, 60000);
