// Fayda (NIDP) IDA partner settings. Each comes from an environment variable (the .env file, or the
// container's environment); the value after || is only the fallback for a server that has not set it.
// The license key, API key and .p12 password are secrets: set them in the environment and, once the
// credentials have been replaced with Fayda, remove the fallbacks below.
const env = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== '' ? process.env[name] : fallback);

const baseUrl = env('FAYDA_BASE_URL', 'https://ida.fayda.et').replace(/\/+$/, '');
const partnerId = env('FAYDA_PARTNER_ID', 'fayda-ethswitch-partner-zemen-bank');
const partnerApiKey = env('FAYDA_PARTNER_API_KEY', 'fayda-partner-zemen-bank-api');
const mispLicenseKey = env('FAYDA_MISP_LICENSE_KEY', 'Zp4mQXtH9aCk2RydF7nWjL3uVbPSq8gTmhK1xDeNfUYr0BwCsGt');
const idaUrl = kind => `${baseUrl}/idauthentication/v1/${kind}/${mispLicenseKey}/${partnerId}/${partnerApiKey}`;

const faydaConfig = {
  'fayda.base.url': baseUrl,
  'fayda.partner.id': partnerId,
  'fayda.env': env('FAYDA_ENV', 'Production'),
  'partnerId': partnerId,
  'partnerApiKey': partnerApiKey,
  'mispLicenseKey': mispLicenseKey,
  'ida.reference.id': env('FAYDA_REFERENCE_ID', 'PARTNER'),

  // Folder with the partner .p12 key files (in Docker: the mounted keys folder, e.g. /app/keys)
  'p12.path': env('FAYDA_KEYS_PATH', 'D:\\fayda_integration-master (1)\\Production_FAYDA\\keys'),
  'p12.password': env('FAYDA_P12_PASSWORD', 'zemenqwertyXSW@'),
  'ida.ssl.verify': env('FAYDA_SSL_VERIFY', 'false'),

  'ida.otp.url': idaUrl('otp'),
  'ida.auth.url': idaUrl('auth'),
  'ida.ekyc.url': idaUrl('kyc'),
  'ida.certificate.url': `${baseUrl}/mosip-certs/ida-partner.cer`,
};

module.exports = faydaConfig;
