'use strict';
const express = require('express');
const config = require('../config');
const db = require('../db');
const { ensureReady } = require('../db/setup');
const { databaseHint } = require('../utils/dbErrors');

const router = express.Router();

// Shows whether the server is configured and can reach the database. Safe to open in a browser.
router.get('/', async (req, res) => {
  const report = { ok: true, problems: [...config.problems], database: 'not checked' };
  if (config.hasDatabaseUrl) {
    try {
      await ensureReady();
      const { rooms } = await db.get('SELECT count(*)::int AS rooms FROM rooms WHERE is_active');
      const { admins } = await db.get("SELECT count(*)::int AS admins FROM users WHERE role = 'admin' AND is_active");
      report.database = `connected, ${rooms} rooms, ${admins} admin${admins === 1 ? '' : 's'}`;
      if (admins === 0) {
        report.next = config.adminEmails.length
          ? `Register on the site with ${config.adminEmails.join(' or ')} to become the admin.`
          : 'No admin yet: add ADMIN_EMAILS (your email) in Vercel → Settings → Environment Variables, redeploy, then register with that email.';
      }
    } catch (err) {
      console.error('[health]', err);
      report.database = `failed (${err.code || 'error'})`;
      report.problems.push(databaseHint(err) || 'Unexpected database error. See Vercel → Deployments → Logs.');
    }
  }
  report.ok = report.problems.length === 0;
  res.status(report.ok ? 200 : 503).json(report);
});

module.exports = router;
