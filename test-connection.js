const https = require('https');
const axios = require('axios');

// Same setup as the SDK's HttpClientUtil
const agent = new https.Agent({ rejectUnauthorized: false });
const instance = axios.create({ httpsAgent: agent, timeout: 10000 });

const certUrl = 'https://ida.fayda.et/mosip-certs/ida-partner.cer';
const otpUrl =
  'https://ida.fayda.et/idauthentication/v1/otp/Zp4mQXtH9aCk2RydF7nWjL3uVbPSq8gTmhK1xDeNfUYr0BwCsGt/fayda-ethswitch-partner-zemen-bank/fayda-partner-zemen-bank-api';

async function test() {
  console.log('Step 1: GET certificate...');
  const cert = await instance.get(certUrl, { validateStatus: () => true });
  console.log('Step 1 OK — status:', cert.status, '| length:', String(cert.data).length);

  console.log('Step 2: POST to OTP endpoint (same axios instance)...');
  const otp = await instance.post(
    otpUrl,
    { test: true },
    {
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    }
  );
  console.log('Step 2 OK — status:', otp.status);
}

test().catch((e) => console.log('ERROR:', e.message));