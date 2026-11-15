'use strict';
const express = require('express');
const access = require('../services/access');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Ask for lecturer or admin access with an offer or appointment letter (base64 in JSON).
router.post('/', async (req, res) => {
  res.status(201).json({ request: await access.create(req.user, req.body ?? {}, { ip: req.ip }) });
});

// The signed-in person's latest request and its status.
router.get('/mine', async (req, res) => {
  res.json({ request: await access.mine(req.user) });
});

module.exports = router;
