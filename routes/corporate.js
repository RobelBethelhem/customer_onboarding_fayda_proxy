/**
 * Business account applications from the web app, passed on to the Customer Onboarding
 * dashboard's public corporate API (/api/corporate/public/*): organization types and documents,
 * file uploads, submission, the applicant's status page and the SMS verification links.
 * The dashboard checks everything itself; this only relays (the web app reaches the dashboard
 * through this server, like the rest of the onboarding).
 */
const express = require('express');
const axios = require('axios');
const { forwardedForHeader } = require('../lib/clientIp');

const router = express.Router();

// Read on use: routes load before dotenv in server.js
const dashboard = () => (process.env.CUSTOMER_ONBOARDING_API || 'http://localhost:3500').replace(/\/+$/, '');

// The only paths the web app needs
const ALLOWED = /^\/(catalog|files|applications|applications\/[A-Za-z0-9-]{1,20}|invites\/[A-Za-z0-9_-]{20,100})$/;

router.use(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  if (!ALLOWED.test(req.path)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  try {
    const response = await axios({
      method: req.method,
      url: `${dashboard()}/api/corporate/public${req.path}`,
      params: req.query,
      data: req.method === 'POST' ? req.body : undefined,
      headers: { 'Content-Type': 'application/json', ...forwardedForHeader(req) },
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    const body = response.data && typeof response.data === 'object'
      ? response.data
      : { success: false, error: 'Unexpected answer from the bank system' };
    if (response.status >= 500) {
      console.error(`[Corporate] ${req.method} ${req.path} → ${response.status}:`, body.error, body.detail || '');
    }
    res.status(response.status).json(body);
  } catch (error) {
    console.error(`[Corporate] ${req.method} ${req.path} — dashboard unreachable:`, error.message);
    res.status(502).json({ success: false, error: 'The bank system is not reachable right now. Please try again in a moment.' });
  }
});

module.exports = router;
