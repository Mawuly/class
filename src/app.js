'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { authenticate } = require('./middleware/auth');
const { requireXhr } = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errors');

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
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

const api = express.Router();
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use(requireXhr);
api.use(authenticate);
api.use('/public', require('./routes/public'));
api.use('/auth', require('./routes/auth'));
api.use('/rooms', require('./routes/rooms'));
api.use('/bookings', require('./routes/bookings'));
api.use('/admin', require('./routes/admin'));
api.use('/notifications', require('./routes/notifications'));
api.use(notFound);
app.use('/api', api);

// On Vercel, files in public/ are served by the CDN before reaching this function.
// Locally, Express serves them itself.
if (!process.env.VERCEL) {
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
}

app.use(notFound);
app.use(errorHandler);

module.exports = app;
