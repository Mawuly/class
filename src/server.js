'use strict';
// Local development server. On Vercel, api/index.js exports the same app instead.
const config = require('./config');
const app = require('./app');

app.listen(config.port, () => {
  console.log(`Lecture Rooms running at http://localhost:${config.port}`);
});
