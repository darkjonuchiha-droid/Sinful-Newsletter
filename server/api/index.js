'use strict';
// Vercel serverless entry — vercel.json rewrites every path here and the
// Express app handles routing (API + static admin UI).
module.exports = require('../src/app');
