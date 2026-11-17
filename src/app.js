'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { authenticate, requirePasswordChosen } = require('./middleware/auth');
const { requireXhr } = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errors');
const { AppError } = require('./utils/errors');
const { ensureReady } = require('./db/setup');
const settings = require('./services/settings');
const { releaseIfDue } = require('./services/checkin');
const { loadIfStale: loadSettingsIfStale } = require('./services/settings');

const app = express();

// Behind Vercel's proxy: trust its X-Forwarded-For so req.ip and rate limiting see the real client.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
// Staff access requests carry a letter of up to 3 MB (about 4 MB as base64). Vercel caps request
// bodies at 4.5 MB. Every other route keeps a small limit.
app.use(['/api/access-requests', '/api/access'], express.json({ limit: '4400kb' }));
// A pasted timetable can be a few hundred rows.
app.use('/api/admin/timetables', express.json({ limit: '300kb' }));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

const api = express.Router();
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use('/health', require('./routes/health'));
// With settings missing, answer clearly instead of crashing (the page itself still loads).
api.use((req, res, next) => {
  if (!config.problems.length) return next();
  next(new AppError(503, `The server is not set up yet. ${config.problems.join('. ')}. Then redeploy.`));
});
// First request on a fresh database creates the tables and rooms (see db/setup.js).
api.use(async (req, res, next) => {
  await ensureReady();
  await settings.load();
  next();
});
api.use(requireXhr);
api.use(authenticate);
api.use(requirePasswordChosen);
// Free the rooms of bookings nobody checked in to, before anything reads them.
api.use(async (req, res, next) => {
  await loadSettingsIfStale();
  await releaseIfDue();
  next();
});
api.use('/public', require('./routes/public'));
api.use('/auth', require('./routes/auth'));
api.use('/rooms', require('./routes/rooms'));
api.use('/bookings', require('./routes/bookings'));
api.use('/admin', require('./routes/admin'));
api.use('/notifications', require('./routes/notifications'));
api.use('/access-requests', require('./routes/access'));
api.use('/access', require('./routes/access')); // the name used in the implementation guide
api.use('/calendar', require('./routes/calendar').router);
api.use('/door', require('./routes/door'));
api.use(notFound);
app.use('/api', api);

// On Vercel the CDN normally serves public/ before a request reaches this function;
// serving it here as well means the site still works if every request is routed to Express.
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
