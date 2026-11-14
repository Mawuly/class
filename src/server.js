'use strict';
// Local development server. On Vercel, api/index.js exports the same app instead.
// Exporting it here too means Vercel's Express detection also finds a working app.
const config = require('./config');
const app = require('./app');

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Lecture Rooms running at http://localhost:${config.port}`);
  });
}

module.exports = app;
