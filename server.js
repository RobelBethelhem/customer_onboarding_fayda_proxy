// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const axios = require('axios');
// const mongoose = require('mongoose');
// const { initializeOracle } = require('./lib/oracleDb');

// // Import routes
// const flexcubeRoutes = require('./routes/flexcube');
// const harmonizationRoutes = require('./routes/harmonization');
// const adminRoutes = require('./routes/admin');
// const faceVerificationRoutes = require('./routes/faceVerification');

// const app = express();
// const PORT = process.env.PORT || 5000;

// // Middleware
// app.use(cors());
// app.use(express.json({ limit: '50mb' }));

// const FAYDA_API_BASE = 'https://api-resident.fayda.et';

// // Connect to MongoDB
// mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fayda_harmonization')
//   .then(() => console.log('Connected to MongoDB'))
//   .catch(err => console.error('MongoDB connection error:', err));

// // Initialize Oracle connection
// initializeOracle()
//   .then(() => console.log('Oracle initialization complete'))
//   .catch(err => console.error('Oracle initialization error:', err));

// // Verify FCN endpoint - proxies to Fayda verify API
// app.post('/api/verify', async (req, res) => {
//   try {
//     const { idNumber, captchaValue } = req.body;

//     if (!idNumber) {
//       return res.status(400).json({ error: 'FCN (idNumber) is required' });
//     }

//     const payload = {
//       captchaValue: captchaValue || '',
//       idNumber: idNumber,
//       verificationMethod: 'FCN'
//     };

//     const response = await axios.post(`${FAYDA_API_BASE}/verify`, payload, {
//       headers: {
//         'Content-Type': 'application/json'
//       }
//     });

//     res.json(response.data);
//   } catch (error) {
//     console.error('Verify error:', error.response?.data || error.message);
//     res.status(error.response?.status || 500).json({
//       error: error.response?.data || 'Failed to verify FCN'
//     });
//   }
// });

// // Validate OTP endpoint - proxies to Fayda validateOtp API
// app.post('/api/validateOtp', async (req, res) => {
//   try {
//     const { otp, uniqueId, token } = req.body;

//     if (!otp || !uniqueId || !token) {
//       return res.status(400).json({ error: 'OTP, uniqueId, and token are required' });
//     }

//     const payload = {
//       otp: otp,
//       uniqueId: uniqueId,
//       verificationMethod: 'FCN'
//     };

//     const response = await axios.post(`${FAYDA_API_BASE}/validateOtp`, payload, {
//       headers: {
//         'Content-Type': 'application/json',
//         'Authorization': `Bearer ${token}`
//       }
//     });

//     res.json(response.data);
//   } catch (error) {
//     console.error('ValidateOtp error:', error.response?.data || error.message);
//     res.status(error.response?.status || 500).json({
//       error: error.response?.data || 'Failed to validate OTP'
//     });
//   }
// });

// // Resend FCN via phone - proxies to Fayda resend API
// app.post('/api/resend', async (req, res) => {
//   try {
//     const { identifier } = req.body;

//     if (!identifier) {
//       return res.status(400).json({ message: 'Phone number is required' });
//     }

//     const payload = {
//       identifier: identifier
//     };

//     const response = await axios.post(`${FAYDA_API_BASE}/resend`, payload, {
//       headers: {
//         'Content-Type': 'application/json'
//       }
//     });

//     res.json(response.data);
//   } catch (error) {
//     console.error('Resend error:', error.response?.data || error.message);
//     res.status(error.response?.status || 500).json({
//       message: error.response?.data?.message || 'Phone number not found in the system'
//     });
//   }
// });

// // FlexCube routes
// app.use('/api/flexcube', flexcubeRoutes);

// // Harmonization routes
// app.use('/api/harmonization', harmonizationRoutes);

// // Admin routes
// app.use('/api/admin', adminRoutes);

// // Face verification routes (face-api.js)
// app.use('/api/face', faceVerificationRoutes);

// // Customer Onboarding API URL for screening
// const CUSTOMER_ONBOARDING_API = process.env.CUSTOMER_ONBOARDING_API || 'http://localhost:3500';

// // Sanctions/PEP Screening - proxies to Customer Onboarding API
// app.post('/api/screening/check', async (req, res) => {
//   try {
//     const { firstName, middleName, lastName, dateOfBirth, nationality } = req.body;

//     if (!firstName || !lastName) {
//       return res.status(400).json({
//         success: false,
//         error: 'First name and last name are required for screening'
//       });
//     }

//     console.log('Screening check for:', { firstName, middleName, lastName });

//     const response = await axios.post(`${CUSTOMER_ONBOARDING_API}/api/screening/check`, {
//       firstName,
//       middleName,
//       lastName,
//       dateOfBirth,
//       nationality
//     }, {
//       headers: { 'Content-Type': 'application/json' },
//       timeout: 30000
//     });

//     res.json(response.data);
//   } catch (error) {
//     console.error('Screening check error:', error.response?.data || error.message);

//     // If Customer Onboarding API is not available, allow the customer through
//     // (fail-open for business continuity, but log the issue)
//     if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
//       console.warn('WARNING: Screening service unavailable, allowing customer through');
//       return res.json({
//         success: true,
//         blocked: false,
//         riskLevel: 'UNKNOWN',
//         message: 'Screening service temporarily unavailable',
//         matches: []
//       });
//     }

//     res.status(error.response?.status || 500).json({
//       success: false,
//       error: error.response?.data?.error || 'Failed to perform screening check'
//     });
//   }
// });

// // Health check
// app.get('/api/health', (req, res) => {
//   res.json({
//     status: 'ok',
//     mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
//     timestamp: new Date().toISOString()
//   });
// });

// // Listen on all network interfaces (0.0.0.0) so physical devices can connect
// const HOST = '0.0.0.0';
// app.listen(PORT, HOST, () => {
//   console.log(`Server running on http://${HOST}:${PORT}`);
//   console.log(`For physical devices, use your computer's IP address (run 'ipconfig' to find it)`);
// });


































































const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const https = require('https');
const { convertPhotoToJpeg } = require('./lib/convertJp2');
const { initializeOracle } = require('./lib/oracleDb');
const { IdaClientFactory } = require('fayda-auth-client');
const faydaConfig = require('./services/faydaConfig');

// Import routes
const flexcubeRoutes = require('./routes/flexcube');
const harmonizationRoutes = require('./routes/harmonization');
const adminRoutes = require('./routes/admin');
const faceVerificationRoutes = require('./routes/faceVerification');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Fayda connectivity test
axios
  .post(
    'https://ida.fayda.et/idauthentication/v1/otp/test',
    {},
    {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10000,
    }
  )
  .catch((e) => console.log('Fayda connectivity test:', e.message));

// ── Fayda IDA SDK setup ───────────────────────────────────────────────────────
const faydaClient = IdaClientFactory.createClient(faydaConfig);

// In-memory transactionID store: individualId → { transactionID, createdAt }
const txnStore = new Map();

// Database connections are initialized in startServer() below

  const CUSTOMER_ONBOARDING_API = process.env.CUSTOMER_ONBOARDING_API || 'http://localhost:3500/';

  app.post('/api/screening/check', async (req, res) => {
    try {
      const { firstName, middleName, lastName, dateOfBirth, nationality } = req.body;
  
      if (!firstName || !lastName) {
        return res.status(400).json({
          success: false,
          error: 'First name and last name are required for screening',
        });
      }
  
      console.log('Screening check for:', { firstName, middleName, lastName });
  
      const response = await axios.post(
        `${CUSTOMER_ONBOARDING_API}/api/screening/check`,
        { firstName, middleName, lastName, dateOfBirth, nationality },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );
  
      res.json(response.data);
    } catch (error) {
      console.error('Screening check error:', error.response?.data || error.message);
  
      // If Customer Onboarding API is not available, allow the customer through (fail-open)
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        console.warn('WARNING: Screening service unavailable, allowing customer through');
        return res.json({
          success: true,
          blocked: false,
          riskLevel: 'UNKNOWN',
          message: 'Screening service temporarily unavailable',
          matches: [],
        });
      }
  
      res.status(error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error || 'Failed to perform screening check',
      });
    }
  });




// ── NEW: Fayda IDA SDK endpoints ───────────────────────────────────────────────

/**
 * POST /api/fayda/request-otp
 */
app.post('/api/fayda/request-otp', async (req, res) => {
  try {
    const { individualId, otpChannel = ['PHONE', 'EMAIL']} = req.body;



console.log('ida.otp.url =', faydaConfig['ida.otp.url']);
console.log('ida.auth.url =', faydaConfig['ida.auth.url']);
console.log('ida.ekyc.url =', faydaConfig['ida.ekyc.url']);
console.log('ida.certificate.url =', faydaConfig['ida.certificate.url']);



    console.log('request-otp:', individualId, otpChannel);

    if (!individualId) {
      return res.status(400).json({
        error: 'individualId (16-digit FAN) is required',
      });
    }

    const otpRequest = {
      individualId: individualId.trim(),
      individualIdType: 'FAN',
      otpChannel: otpChannel || ['PHONE'],
    };


    console.log("ghjhjhjhjhj",otpRequest)

    const otpRes = await faydaClient.requestOtp(otpRequest);



    console.log("jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj", otpRes)

    if (otpRes.errors && otpRes.errors.length > 0) {
      return res.status(422).json({
        success: false,
        errors: otpRes.errors,
      });
    }

    // SDK sets transactionID on the request object before sending — use it as fallback
    const transactionID =
      otpRes.transactionID ??
      otpRes['transactionId'] ??
      otpRes['transaction_id'] ??
      otpRequest.transactionID;

    txnStore.set(individualId.trim(), {
      transactionID,
      createdAt: Date.now(),
    });

    res.json({
      success: true,
      transactionID,
      maskedMobile: otpRes.response?.maskedMobile ?? otpRes['maskedMobile'] ?? null,
    });
  } catch (err) {
    console.error('Fayda request-otp error:', err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/fayda/ekyc
 */
// app.post('/api/fayda/ekyc', async (req, res) => {
//   try {
//     const { individualId, otp } = req.body;

//     if (!individualId || !otp) {
//       return res.status(400).json({
//         error: 'individualId and otp are required',
//       });
//     }

//     const stored = txnStore.get(individualId.trim());
//     if (!stored) {
//       return res.status(400).json({
//         error: 'No pending OTP for this individualId. Call /api/fayda/request-otp first.',
//       });
//     }

//     const ekycRes = await faydaClient.performEkyc({
//       individualId: individualId.trim(),
//       individualIdType: 'FAN',
//       otp: otp.trim(),
//       transactionID: stored.transactionID,
//     });

//     res.json(ekycRes);
//   } catch (err) {
//     console.error('Fayda ekyc error:', err?.message || err);
//     res.status(500).json({ error: err?.message || String(err) });
//   }
// });



// ──────────────────────────────────────────────────────────────────────────────
// FlexCube routes




app.post('/api/fayda/ekyc', async (req, res) => {
  try {
    const { individualId, otp } = req.body;

    if (!individualId || !otp) {
      return res.status(400).json({ error: 'individualId and otp are required' });
    }

    const stored = txnStore.get(individualId.trim());
    if (!stored) {
      return res.status(400).json({
        error: 'No pending OTP for this individualId. Call /api/fayda/request-otp first.',
      });
    }

    const ekycRes = await faydaClient.performEkyc({
      individualId: individualId.trim(),
      individualIdType: 'FAN',
      otp: otp.trim(),
      transactionID: stored.transactionID,
    });

    // ✅ Convert JP2K photo to JPEG base64 before sending to frontend
    if (ekycRes?.identity?.photo) {
      ekycRes.identity.photo = await convertPhotoToJpeg(ekycRes.identity.photo);
    }

    res.json(ekycRes);
  } catch (err) {
    console.error('Fayda ekyc error:', err?.message || err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});








app.use('/api/flexcube', flexcubeRoutes);

// Harmonization routes
app.use('/api/harmonization', harmonizationRoutes);

// Admin routes
app.use('/api/admin', adminRoutes);

// Face verification routes
app.use('/api/face', faceVerificationRoutes);

// Customer Onboarding API URL for screening


// Sanctions/PEP Screening - proxies to Customer Onboarding API


// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// Start server — await database connections before accepting requests
const HOST = '0.0.0.0';

async function startServer() {
  // 1. Connect to MongoDB
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fayda_harmonization');
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }

  // 2. Initialize Oracle — MUST complete before accepting requests
  try {
    await initializeOracle();
    console.log('Oracle initialization complete');
  } catch (err) {
    console.error('Oracle initialization error:', err.message);
    console.warn('Server will start but Oracle features (photo save) may not work');
  }

  // 3. Start listening only after all connections are ready
  app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(`For physical devices, use your computer's IP address (run 'ipconfig' to find it)`);
  });
}

startServer();