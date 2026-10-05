const express = require('express');
const router = express.Router();
const axios = require('axios');
const { executeQuery } = require('../lib/oracleDb');
const { forwardedForHeader } = require('../lib/clientIp');
const faceResult = require('../lib/faceResult');

const DB_SHEMA = process.env.FLEXCUBE_DB_SCHEMA || 'FCUBSPRD';

// FlexCube SOAP Web Service Configuration
const FLEXCUBE_WS_URL = 'http://10.1.1.155:7107/FCUBSCustomerService/FCUBSCustomerService';

// Generate unique message ID for SOAP requests
function generateMessageId() {
  const timestamp = Date.now().toString();
  const random = Math.random().toString(36).substring(2, 8);
  return `MSG${timestamp}${random}`;
}

// Build FlexCube CreateCustomer SOAP XML
function buildCreateCustomerSoapXml(customerData) {
  const msgId = generateMessageId();
  const today = new Date().toISOString().split('T')[0];

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fcub="http://fcubs.ofss.com/service/FCUBSCustomerService">
  <soapenv:Header/>
  <soapenv:Body>
    <fcub:CREATECUSTOMER_FSFS_REQ>
      <fcub:FCUBS_HEADER>
        <fcub:SOURCE>EXTMB</fcub:SOURCE>
        <fcub:UBSCOMP>FCUBS</fcub:UBSCOMP>
        <fcub:USERID>MB_SER</fcub:USERID>
        <fcub:BRANCH>103</fcub:BRANCH>
        <fcub:MSGID>${msgId}</fcub:MSGID>
        <fcub:SERVICE>FCUBSCustomerService</fcub:SERVICE>
        <fcub:OPERATION>CreateCustomer</fcub:OPERATION>
      </fcub:FCUBS_HEADER>
      <fcub:FCUBS_BODY>
        <fcub:Customer-Full>
          <fcub:CUSTNO/>
          <fcub:TYPE>I</fcub:TYPE>
          <fcub:CATEGORY>INDIV</fcub:CATEGORY>
          <fcub:FROZEN>N</fcub:FROZEN>
          <fcub:FRZ_RSN/>
          <fcub:NAME>${customerData.fullName || ''}</fcub:NAME>
          <fcub:SALUTATION>${customerData.salutation || 'MR'}</fcub:SALUTATION>
          <fcub:FNAME>${customerData.firstName || ''}</fcub:FNAME>
          <fcub:MNAME>${customerData.middleName || ''}</fcub:MNAME>
          <fcub:LNAME>${customerData.lastName || ''}</fcub:LNAME>
          <fcub:GENDER>${customerData.gender || 'M'}</fcub:GENDER>
          <fcub:DOB>${customerData.dateOfBirth || ''}</fcub:DOB>
          <fcub:NATION>${customerData.nationality || 'ET'}</fcub:NATION>
          <fcub:LANGUAGE>ENG</fcub:LANGUAGE>
          <fcub:DECEASED>N</fcub:DECEASED>
          <fcub:MINOR>N</fcub:MINOR>
          <fcub:STAFF>N</fcub:STAFF>
          <fcub:CUST_AC_NO/>
          <fcub:GL_CODE/>
          <fcub:SHORTNAME>${(customerData.firstName || '').substring(0, 20)}</fcub:SHORTNAME>
          <fcub:COUNTRY>ET</fcub:COUNTRY>
          <fcub:NATIDTYPE>FNID</fcub:NATIDTYPE>
          <fcub:NATID>${customerData.faydaId || ''}</fcub:NATID>
          <fcub:SWIFTCODE/>
          <fcub:TIN>${customerData.tin || ''}</fcub:TIN>
          <fcub:MOMMAIDEN>${customerData.motherMaidenName || ''}</fcub:MOMMAIDEN>
          <fcub:MARSTAT>${customerData.maritalStatus || 'S'}</fcub:MARSTAT>
          <fcub:OCCUP>${customerData.occupation || ''}</fcub:OCCUP>
          <fcub:EMPID/>
          <fcub:INCOME>${customerData.monthlyIncome || ''}</fcub:INCOME>
          <fcub:Customer-Address>
            <fcub:ADDR1>${customerData.address1 || ''}</fcub:ADDR1>
            <fcub:ADDR2>${customerData.address2 || ''}</fcub:ADDR2>
            <fcub:ADDR3>${customerData.address3 || ''}</fcub:ADDR3>
            <fcub:ADDR4>${customerData.address4 || ''}</fcub:ADDR4>
            <fcub:CITY>${customerData.city || ''}</fcub:CITY>
            <fcub:STATE>${customerData.state || ''}</fcub:STATE>
            <fcub:COUNTRY>ET</fcub:COUNTRY>
            <fcub:POSTALCODE>${customerData.postalCode || ''}</fcub:POSTALCODE>
          </fcub:Customer-Address>
          <fcub:Customer-Contact>
            <fcub:MOBILE>${customerData.mobile || ''}</fcub:MOBILE>
            <fcub:PHONE>${customerData.phone || ''}</fcub:PHONE>
            <fcub:EMAIL>${customerData.email || ''}</fcub:EMAIL>
          </fcub:Customer-Contact>
        </fcub:Customer-Full>
      </fcub:FCUBS_BODY>
    </fcub:CREATECUSTOMER_FSFS_REQ>
  </soapenv:Body>
</soapenv:Envelope>`;
}

// Parse SOAP response to extract customer number
function parseCreateCustomerResponse(xmlResponse) {
  // Extract CUSTNO from response
  const custNoMatch = xmlResponse.match(/<fcub:CUSTNO>([^<]+)<\/fcub:CUSTNO>/);
  const msgStatMatch = xmlResponse.match(/<fcub:MSGSTAT>([^<]+)<\/fcub:MSGSTAT>/);
  const errorMatch = xmlResponse.match(/<fcub:EDESC>([^<]*)<\/fcub:EDESC>/);

  return {
    success: msgStatMatch && msgStatMatch[1] === 'SUCCESS',
    customerNumber: custNoMatch ? custNoMatch[1] : null,
    status: msgStatMatch ? msgStatMatch[1] : 'UNKNOWN',
    error: errorMatch ? errorMatch[1] : null
  };
}

// Extract customer number from account number
// Account format: 1641411169565016 → customer_no starts at position 6, length 7 → "1169565"
function extractCustomerNumber(accountNumber) {
  if (!accountNumber || accountNumber.length < 13) {
    return null;
  }
  // Starting from 7th digit (index 6), take 7 digits
  return accountNumber.substring(6, 13);
}









// router.post('/set-no-debit', async (req,res) => {
//   try{
//     const { accountNumber} = req.body;
//     console.log(`[NoDebit] Received request to set No-Debit for account: ${accountNumber}`)

//     if(!accountNumber){
//       return res.status(400).json({success: false , error: 'accountNumber is Required'});
//     }

//     console.log(`[NoDebit] Setting AC_STAT_NO_DR = 'Y' for account: ${accountNumber}`)

//     const result = await executeQuery(
//       `UPDATE ${DB_SHEMA}.STTM_CUST_ACCOUNT SET AC_STAT_NO_DR= 'Y' where CUST_AC_NO =:1`,
//       [accountNumber],
//       {autoCommit: true }
//     );

//     if(!result.success){
//       console.error(`[NoDebit'] Update failed: ${result.error}`);
//       return res.status(500).json({success: false, error: result.error})
//     }

//     if(result.rowsAffected === 0){
//       console.warn(`[NoDebit] No rows updated for account: ${accountNumber}`)
//       return res.status(404).json({success: false , error: 'Account Not found in STTM_CUST_ACCOUNT'})
//     }

//     console.log(`[NoDebit] Successfully set No-Debit = 'Y' for account: ${accountNumber}` )
//     return res.json({
//       success: true,
//       message: 'Account set to No Debit',
//       accountNumber,
//       rowsAffected: result.rowsAffected
//     })
//   }
//   catch( error){
//     console.error('[NoDebit] Error:', error)
//     return res.status(500).json({success: false, error: error.message || 'Failed to set No Debit'})
//   }
// })










// Get customer data from FlexCube by account number



router.post('/set-no-debit', async (req, res) => {
  try {
    const { accountNumber } = req.body;

    console.log(`[NoDebit] Received request to set No-Debit for account: ${accountNumber}`);

    if (!accountNumber) {
      return res.status(400).json({
        success: false,
        error: 'accountNumber is Required'
      });
    }

    console.log(`[NoDebit] Setting AC_STAT_NO_DR = 'Y' for account: ${accountNumber}`);

    // Update STTM_CUST_ACCOUNT
    const result1 = await executeQuery(
      `UPDATE ${DB_SHEMA}.STTM_CUST_ACCOUNT
       SET AC_STAT_NO_DR = 'Y'
       WHERE CUST_AC_NO = :1`,
      [accountNumber],
      { autoCommit: true }
    );

    if (!result1.success) {
      return res.status(500).json({
        success: false,
        error: result1.error
      });
    }

    // Update STTM_ACCOUNT_BALANCE
    // const result2 = await executeQuery(
    //   `UPDATE ${DB_SHEMA}.STTM_ACCOUNT_BALANCE
    //    SET AC_STAT_NO_DR = 'Y'
    //    WHERE CUST_AC_NO = :1`,
    //   [accountNumber],
    //   { autoCommit: false }
    // );

    // if (!result2.success) {
    //   return res.status(500).json({
    //     success: false,
    //     error: result2.error
    //   });
    // }

    // Update STTB_ACCOUNT
    const result3 = await executeQuery(
      `UPDATE ${DB_SHEMA}.STTB_ACCOUNT
       SET AC_STAT_NO_DR = 'Y'
       WHERE AC_GL_NO = :1`,
      [accountNumber],
      { autoCommit: true } // Commit all updates here
    );

    if (!result3.success) {
      return res.status(500).json({
        success: false,
        error: result3.error
      });
    }

    const totalRows =
      (result1.rowsAffected || 0) +
      // (result2.rowsAffected || 0) +
      (result3.rowsAffected || 0);

    if (totalRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Account not found in any table'
      });
    }

    console.log(`[NoDebit] Successfully set No-Debit for account: ${accountNumber}`);

    return res.json({
      success: true,
      message: 'Account set to No Debit successfully.',
      accountNumber,
      rowsAffected: {
        STTM_CUST_ACCOUNT: result1.rowsAffected,
        // STTM_ACCOUNT_BALANCE: result2.rowsAffected,
        STTB_ACCOUNT: result3.rowsAffected
      }
    });

  } catch (error) {
    console.error('[NoDebit] Error:', error);

    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to set No Debit'
    });
  }
});



router.post('/customer', async (req, res) => {
  try {
    const { accountNumber } = req.body;

    if (!accountNumber) {
      return res.status(400).json({ message: 'Account number is required' });
    }

    // Extract customer number from account
    const customerNumber = extractCustomerNumber(accountNumber);

    if (!customerNumber) {
      return res.status(400).json({ message: 'Invalid account number format' });
    }

    // Query FlexCube for customer data
    const query = `
      SELECT
        CUSTOMER_NO,
        CUSTOMER_PREFIX,
        FIRST_NAME,
        MIDDLE_NAME,
        LAST_NAME,
        DATE_OF_BIRTH,
        SEX,
        MOBILE_NUMBER,
        E_MAIL,
        P_NATIONAL_ID,
        RESIDENT_STATUS,
        P_ADDRESS1,
        P_ADDRESS2,
        P_ADDRESS3,
        P_ADDRESS4,
        P_COUNTRY,
        D_ADDRESS1,
        D_ADDRESS2,
        D_ADDRESS3,
        D_ADDRESS4,
        D_COUNTRY,
        MOTHER_MAIDEN_NAME,
        PLACE_OF_BIRTH,
        BIRTH_COUNTRY,
        TELEPHONE
      FROM FCUBSPRD.STTM_CUST_PERSONAL
      WHERE CUSTOMER_NO = :1
    `;

    const result = await executeQuery(query, [customerNumber]);

    if (!result.success) {
      return res.status(500).json({
        message: 'Failed to query FlexCube database',
        error: result.error
      });
    }

    if (!result.data || result.data.length === 0) {
      return res.status(404).json({
        message: 'Customer not found in FlexCube',
        customerNumber
      });
    }

    const customer = result.data[0];

    // Format the response
    const flexcubeData = {
      customerNo: customer.CUSTOMER_NO,
      firstName: customer.FIRST_NAME,
      middleName: customer.MIDDLE_NAME,
      lastName: customer.LAST_NAME,
      fullName: [customer.FIRST_NAME, customer.MIDDLE_NAME, customer.LAST_NAME]
        .filter(Boolean)
        .join(' '),
      dateOfBirth: customer.DATE_OF_BIRTH,
      sex: customer.SEX === 'M' ? 'Male' : customer.SEX === 'F' ? 'Female' : customer.SEX,
      mobileNumber: customer.MOBILE_NUMBER,
      telephone: customer.TELEPHONE,
      email: customer.E_MAIL,
      nationalId: customer.P_NATIONAL_ID,
      residentStatus: customer.RESIDENT_STATUS === 'R' ? 'Resident' : 'Non-Resident',
      permanentAddress1: customer.P_ADDRESS1,
      permanentAddress2: customer.P_ADDRESS2,
      permanentAddress3: customer.P_ADDRESS3,
      permanentAddress4: customer.P_ADDRESS4,
      permanentCountry: customer.P_COUNTRY,
      domesticAddress1: customer.D_ADDRESS1,
      domesticAddress2: customer.D_ADDRESS2,
      domesticAddress3: customer.D_ADDRESS3,
      domesticAddress4: customer.D_ADDRESS4,
      domesticCountry: customer.D_COUNTRY,
      motherMaidenName: customer.MOTHER_MAIDEN_NAME,
      placeOfBirth: customer.PLACE_OF_BIRTH,
      birthCountry: customer.BIRTH_COUNTRY
    };

    res.json({
      success: true,
      accountNumber,
      customerNumber,
      data: flexcubeData
    });

  } catch (error) {
    console.error('FlexCube customer query error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Update customer data in FlexCube (called after admin approval)
router.post('/update-customer', async (req, res) => {
  try {
    const { customerNumber, updates } = req.body;

    if (!customerNumber || !updates) {
      return res.status(400).json({ message: 'Customer number and updates are required' });
    }

    // Build update query dynamically based on provided fields
    const updateFields = [];
    const params = [];
    let paramIndex = 1;

    // Map Fayda fields to FlexCube columns (excluding phone)
    const fieldMapping = {
      firstName: 'FIRST_NAME',
      middleName: 'MIDDLE_NAME',
      lastName: 'LAST_NAME',
      dateOfBirth: 'DATE_OF_BIRTH',
      sex: 'SEX',
      email: 'E_MAIL',
      nationalId: 'P_NATIONAL_ID',
      permanentAddress1: 'P_ADDRESS1',
      permanentAddress2: 'P_ADDRESS2',
      permanentAddress3: 'P_ADDRESS3',
      motherMaidenName: 'MOTHER_MAIDEN_NAME',
      placeOfBirth: 'PLACE_OF_BIRTH'
    };

    for (const [faydaField, flexField] of Object.entries(fieldMapping)) {
      if (updates[faydaField] !== undefined) {
        updateFields.push(`${flexField} = :${paramIndex}`);
        params.push(updates[faydaField]);
        paramIndex++;
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    // Add customer number as last parameter
    params.push(customerNumber);

    const query = `
      UPDATE FCUBSPRD.STTM_CUST_PERSONAL
      SET ${updateFields.join(', ')}
      WHERE CUSTOMER_NO = :${paramIndex}
    `;

    const result = await executeQuery(query, params);

    if (!result.success) {
      return res.status(500).json({
        message: 'Failed to update FlexCube database',
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Customer data updated successfully',
      rowsAffected: result.rowsAffected
    });

  } catch (error) {
    console.error('FlexCube update error:', error);
    res.status(500).json({
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Customer Onboarding Dashboard API URL
//sconst CUSTOMER_ONBOARDING_API = process.env.CUSTOMER_ONBOARDING_API || 'http://localhost:3500/akal';


const CUSTOMER_ONBOARDING_API = 'http://localhost:3500/';

// Create new customer - checks workflow settings first
router.post('/create-customer', async (req, res) => {
  try {


   req.body.faydaId  =  req.body.uin;

    console.log("yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", req.body)
    const customerData = req.body;

    if(req.body.monthlyIncome < 1000){
      return res.status(400).json({
        success: false,
        message: 'Monthly income must be at least 5000'
      });
    }


    // Validate age (must be 18+)
if (req.body.dateOfBirth) {
  const dob = new Date(req.body.dateOfBirth);

  if (isNaN(dob.getTime())) {
    return res.status(400).json({
      success: false,
      message: 'Invalid date of birth'
    });
  }

  const today = new Date();

  let age = today.getFullYear() - dob.getFullYear();

  const monthDiff = today.getMonth() - dob.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < dob.getDate())
  ) {
    age--;
  }

  if (age < 18) {
    return res.status(400).json({
      success: false,
      message: 'Customer must be at least 18 years old'
    });
  }
}

// 👉 if age >= 18, code continues normally below

    // Enhanced logging for debugging liveness photo submission
    console.log('=== MOBILE APP SUBMISSION DEBUG ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Customer Name:', customerData.fullName || `${customerData.firstName} ${customerData.lastName}` || 'Unknown');

    // Log verification photos details
    console.log('Verification Photos Object:', customerData.verificationPhotos ? 'Present' : 'Missing');
    if (customerData.verificationPhotos) {
      console.log('  - faceCenter:', customerData.verificationPhotos.faceCenter ?
        `Present (${customerData.verificationPhotos.faceCenter.length} chars)` : 'Empty/Missing');
      console.log('  - eyeBlink:', customerData.verificationPhotos.eyeBlink ?
        `Present (${customerData.verificationPhotos.eyeBlink.length} chars)` : 'Empty/Missing');
      console.log('  - headLeft:', customerData.verificationPhotos.headLeft ?
        `Present (${customerData.verificationPhotos.headLeft.length} chars)` : 'Empty/Missing');
      console.log('  - headRight:', customerData.verificationPhotos.headRight ?
        `Present (${customerData.verificationPhotos.headRight.length} chars)` : 'Empty/Missing');
      console.log('  - smile:', customerData.verificationPhotos.smile ?
        `Present (${customerData.verificationPhotos.smile.length} chars)` : 'Empty/Missing');
    }

    // Log individual photo fields (alternate submission format)
    console.log('Individual Photo Fields:');
    console.log('  - faceCenter (root):', customerData.faceCenter ?
      `Present (${customerData.faceCenter.length} chars)` : 'Empty/Missing');
    console.log('  - eyeBlink (root):', customerData.eyeBlink ?
      `Present (${customerData.eyeBlink.length} chars)` : 'Empty/Missing');
    console.log('  - headLeft (root):', customerData.headLeft ?
      `Present (${customerData.headLeft.length} chars)` : 'Empty/Missing');
    console.log('  - headRight (root):', customerData.headRight ?
      `Present (${customerData.headRight.length} chars)` : 'Empty/Missing');
    console.log('  - smile (root):', customerData.smile ?
      `Present (${customerData.smile.length} chars)` : 'Empty/Missing');
    console.log('  - selfiePhoto:', customerData.selfiePhoto ?
      `Present (${customerData.selfiePhoto.length} chars)` : 'Empty/Missing');
    console.log('  - faydaPhoto:', customerData.faydaPhoto ?
      `Present (${customerData.faydaPhoto.length} chars)` : 'Empty/Missing');
    console.log('  - faceMatchScore:', customerData.faceMatchScore || 'Not provided');
    console.log('  - marriageCertificatePhoto:', customerData.marriageCertificatePhoto ?
      `Present (${customerData.marriageCertificatePhoto.length} chars)` : 'Empty/Not provided');
    console.log('  - maritalStatus:', customerData.maritalStatus || 'Not provided');

    console.log('Channel:', customerData.channel || 'mobile_app (default)');
    console.log('Face Video ID:', customerData.faceVideoId || 'None');
    console.log('Address Fields:');
    console.log('  - region:', customerData.region || 'Empty');
    console.log('  - zone:', customerData.zone || 'Empty');
    console.log('  - woreda:', customerData.woreda || 'Empty');
    console.log('=== END DEBUG ===');

    // Validate required fields - accept either fullName OR firstName/lastName
    const hasFullName = customerData.fullName && customerData.fullName.trim();
    const hasFirstLastName = customerData.firstName && customerData.lastName;

    if (!hasFullName && !hasFirstLastName) {
      return res.status(400).json({
        success: false,
        message: 'Full name or first name and last name are required'
      });
    }

    // Prepare data for Customer Onboarding API - pass ALL fields from mobile app
    const onboardingData = {
      fullName: customerData.fullName || [customerData.firstName, customerData.middleName, customerData.lastName].filter(Boolean).join(' '),
      fullNameAmharic: customerData.fullNameAmharic || '',
      phone: customerData.mobile || customerData.phone || '',
      email: customerData.email || '',
      accountType: customerData.accountType || customerData.accountTypeName || 'Savings',
      accountTypeId: customerData.accountTypeId || '',
      accountTypeName: customerData.accountTypeName || '',
      tierId: customerData.tierId || '',
      tierName: customerData.tierName || '',
      tierInterestRate: customerData.tierInterestRate || 0,
      branch: customerData.branch || 'Main Branch',
      branchCode: customerData.branchCode || '',
      uin: customerData.faydaId || customerData.uin || '',
      fcn: customerData.fcn || '',
      gender: customerData.gender === 'M' ? 'male' : customerData.gender === 'F' ? 'female' : customerData.gender || '',
      dateOfBirth: customerData.dateOfBirth || '',
      // Address fields
      region: customerData.region || '',
      zone: customerData.zone || '',
      woreda: customerData.woreda || '',
      kebele: customerData.kebele || '',
      houseNumber: customerData.houseNumber || '',
      // Employment/Financial fields
      occupation: customerData.occupation || '',
      otherOccupation: customerData.otherOccupation || '',
      industry: customerData.industry || '',
      otherIndustry: customerData.otherIndustry || '',
      wealthSource: customerData.wealthSource || '',
      otherWealthSource: customerData.otherWealthSource || '',
      annualIncome: customerData.annualIncome || (customerData.monthlyIncome ? customerData.monthlyIncome * 12 : 0),
      initialDeposit: customerData.initialDeposit || 0,
      motherMaidenName: customerData.motherMaidenName || '',
      maritalStatus: customerData.maritalStatus || '',
      // Marriage certificate photo (only for married customers)
      marriageCertificatePhoto: customerData.marriageCertificatePhoto || '',
      // Photos - Fayda ID photo and selfie
      faydaPhoto: customerData.faydaPhoto || '',
      selfiePhoto: customerData.selfiePhoto || '',
      // Liveness verification photos
      verificationPhotos: customerData.verificationPhotos || {
        faceCenter: customerData.faceCenter || customerData.selfiePhoto || '',
        eyeBlink: customerData.eyeBlink || '',
        headLeft: customerData.headLeft || '',
        headRight: customerData.headRight || '',
        smile: customerData.smile || ''
      },
      // Face match score from liveness verification
      faceMatchScore: customerData.faceMatchScore || 0,
      // Channel: identifies the source of the onboarding request
      // mobile_app, web, whatsapp, telegram, superapp, other
      channel: customerData.channel || 'mobile_app',
      // Face video ID for non-mobile channels (video stored on disk for KYC review)
      faceVideoId: customerData.faceVideoId || '',
      // Referral tracking — forward referral code to dashboard for reward distribution
      referralCode: customerData.referralCode || '',
      // Existing customer — CIF (or 16-digit account number) they already hold. The dashboard
      // verifies it and, on approval, opens only a new account under that CIF.
      existingCustomer: !!customerData.existingCustomer,
      existingCif: customerData.existingCif || '',
      existingAccountNumber: customerData.existingAccountNumber || '',
      // Additional services (Mobile Banking, Debit Card …) — set up by the branch Personal Banker after approval
      requestedServices: Array.isArray(customerData.requestedServices) ? customerData.requestedServices : [],
      // Terms and conditions of those services the customer accepted: [{ id, version, acceptedAt }]
      serviceTermsAccepted: (Array.isArray(customerData.serviceTermsAccepted) ? customerData.serviceTermsAccepted : [])
        .slice(0, 20)
        .filter(a => a && typeof a.id === 'string')
        .map(a => ({ id: a.id, version: Number(a.version) || 0, acceptedAt: String(a.acceptedAt || '') })),
      // FlexCube UDF fields
      promotionType: customerData.promotionType || 'Walk in customer',
      customerSegmentation: customerData.customerSegmentation || 'RETAIL CUSTOMER',
      // Name breakdown (web app sends these separately alongside fullName)
      firstName: customerData.firstName || '',
      middleName: customerData.middleName || '',
      lastName: customerData.lastName || '',
      salutation: customerData.salutation || '',
    };

    // Log what we're sending for debugging
    console.log('Onboarding data - Photos present:', {
      faydaPhoto: !!onboardingData.faydaPhoto,
      selfiePhoto: !!onboardingData.selfiePhoto,
      faceCenter: !!onboardingData.verificationPhotos?.faceCenter,
      eyeBlink: !!onboardingData.verificationPhotos?.eyeBlink,
      headLeft: !!onboardingData.verificationPhotos?.headLeft,
      headRight: !!onboardingData.verificationPhotos?.headRight,
      smile: !!onboardingData.verificationPhotos?.smile,
      faceMatchScore: onboardingData.faceMatchScore
    });
    console.log('Onboarding data - Address:', {
      region: onboardingData.region,
      zone: onboardingData.zone,
      woreda: onboardingData.woreda,
      kebele: onboardingData.kebele,
      houseNumber: onboardingData.houseNumber
    });

    // Web app face check: the result this server signed for this selfie (never a score the browser
    // sends); a web application without one gets its faces compared now, liveness "not verified"
    try {
      const face = await faceResult.forApplication(customerData);
      if (face) Object.assign(onboardingData, face);
    } catch (e) {
      console.error('[Face] Could not attach the face check result:', e.message);
    }

    console.log('Sending customer data to Customer Onboarding API...');

    // Call Customer Onboarding API - this will check workflow settings
    // Large timeout + body limits because payload includes base64 photos (can be 10MB+)
    const onboardingResponse = await axios.post(`${CUSTOMER_ONBOARDING_API}/api/onboarding`, onboardingData, {
      headers: { 'Content-Type': 'application/json', ...forwardedForHeader(req) },
      timeout: 120000,            // 2 minutes
      maxContentLength: 50 * 1024 * 1024,  // 50MB
      maxBodyLength: 50 * 1024 * 1024,     // 50MB
    });


    console.log("88888888888888888888888888888888888888888888888888888888888888888888888888888888888888",onboardingResponse)

    const onboardingResult = onboardingResponse.data;

    if (!onboardingResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Failed to submit to Customer Onboarding',
        error: onboardingResult.error
      });
    }

    // Check if auto-approved (workflow is in auto mode and criteria met)
    if (onboardingResult.data.status === 'auto_approved') {
      // Customer Onboarding already called FlexCube or generated CIF
      console.log('Customer auto-approved:', onboardingResult.data);
      return res.json({
        success: true,
        customerNumber: onboardingResult.data.customerNumber,
        customerId: onboardingResult.data.customerId,
        status: 'auto_approved',
        message: 'Customer created successfully (Auto Approved)',
        workflowDecision: onboardingResult.data.workflowDecision
      });
    }

    // Manual approval mode - customer saved for review
    console.log('Customer submitted for manual review:', onboardingResult.data);
    return res.json({
      success: true,
      customerId: onboardingResult.data.customerId,
      status: 'pending',
      message: 'Application submitted for KYC officer review',
      workflowDecision: onboardingResult.data.workflowDecision
    });

  } catch (error) {
    // The dashboard's own reason (e.g. { error, detail }) — without it a 500 says nothing
    const dashboardReply = error.response && error.response.data;
    console.error('Create customer error:', error.message,
      dashboardReply ? `| dashboard said: ${JSON.stringify(dashboardReply).slice(0, 600)}` : '');

    // Customer Onboarding API rejected the application (e.g. CIF not found) — pass its reason on
    if (error.response && error.response.status >= 400 && error.response.status < 500) {
      return res.status(error.response.status).json({
        success: false,
        message: error.response.data?.error || 'Application could not be submitted',
      });
    }

    // If Customer Onboarding API is not available, fall back to direct FlexCube
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      // Never for an existing customer — the fallback would create them a second CIF
      if (req.body.existingCustomer || req.body.existingCif || req.body.existingAccountNumber) {
        return res.status(503).json({
          success: false,
          message: 'Account opening is temporarily unavailable. Please try again shortly.',
        });
      }
      console.log('Customer Onboarding API not available, falling back to direct FlexCube...');

      try {
        const soapXml = buildCreateCustomerSoapXml(req.body);
        const response = await axios.post(FLEXCUBE_WS_URL, soapXml, {
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': 'CreateCustomer'
          },
          timeout: 60000
        });

        const result = parseCreateCustomerResponse(response.data);

        if (result.success && result.customerNumber) {
          return res.json({
            success: true,
            customerNumber: result.customerNumber,
            message: 'Customer created directly in FlexCube (fallback mode)'
          });
        } else {
          return res.status(400).json({
            success: false,
            message: result.error || 'Failed to create customer in FlexCube'
          });
        }
      } catch (flexError) {
        return res.status(500).json({
          success: false,
          message: 'Failed to create customer',
          error: flexError.message
        });
      }
    }

    res.status(500).json({
      success: false,
      message: 'Failed to process customer request',
      error: (dashboardReply && (dashboardReply.detail || dashboardReply.error)) || error.message
    });
  }
});

// ========== SAVE CUSTOMER PHOTO TO FLEXCUBE ORACLE DB ==========
// Called by Customer Onboarding Dashboard after CIF + Account creation
// Inserts photo into STTM_CIF_PHOTO_MAST and STTM_CUST_PHOTO tables
router.post('/save-customer-photo', async (req, res) => {
  try {
    const { customerNo, branchCode, fullName, photo, maker, makerTimestamp, checker } = req.body;

    if (!customerNo || !photo) {
      return res.status(400).json({
        success: false,
        error: 'customerNo and photo are required',
      });
    }

    console.log(`[Photo] Saving customer photo for CIF: ${customerNo}`);

    // Generate unique specimen sequence number (timestamp-based micro ID)
    const specimenSeqNo = `${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    const fileType = `${customerNo}_image.jpg`;
    const makerDtStamp = makerTimestamp ? new Date(makerTimestamp) : new Date();
    const checkerDtStamp = new Date();
    const makerUpper = (maker || 'WEB_USER').toUpperCase();
    const checkerUpper = (checker || 'KYC_OFFICER').toUpperCase();

    // Strip base64 prefix if present (e.g., "data:image/jpeg;base64,")
    let photoBase64 = photo;
    if (photoBase64.includes(',')) {
      photoBase64 = photoBase64.split(',')[1];
    }

    // Decode base64 to binary buffer for IMAGE column (BLOB)
    const photoBuffer = Buffer.from(photoBase64, 'base64');

    console.log(`[Photo] Photo size: ${photoBuffer.length} bytes, maker: ${makerUpper}, checker: ${checkerUpper}`);
    const photoMasterResultSIG = await executeQuery(
      `INSERT INTO SVTM_CIF_SIG_MASTER
       (CIF_ID, CIF_SIG_ID, BRANCH, CIF_SIG_NAME, CIF_SIG_TITLE, RECORD_STAT, AUTH_STAT, MOD_NO,
       MAKER_ID, MAKER_DT_STAMP, CHECKER_ID, CHECKER_DT_STAMP, ONCE_AUTH, REPL_TO_ACC)
       VALUES
       (:1, :2, :3, :4, :5, 'O', 'A', 1, :6, :7, :8, :9, 'Y', '')`,
      [customerNo,customerNo, branchCode, fullName, fullName, makerUpper, makerDtStamp, checkerUpper, checkerDtStamp]
    );
     if (!photoMasterResultSIG.success) {
      console.error(`[Photo] SVTM_CIF_SIG_MASTER insert failed:`, photoMasterResultSIG.error);
      // Continue — might already exist (duplicate key), try photo insert anyway
    } else {
      console.log(`[Photo] SVTM_CIF_SIG_MASTER inserted for CIF: ${customerNo}`);
    }
    // 1. Insert into STTM_CUST_IMG_MASTER (photo master record)
    const photoMasterResult = await executeQuery(
      `INSERT INTO FCUBSPRD.STTM_CUST_IMG_MASTER
       (CUSTOMER_NO, CIF_SIG_ID, RECORD_STAT, AUTH_STAT, MOD_NO,
        MAKER_ID, MAKER_DT_STAMP, CHECKER_ID, CHECKER_DT_STAMP, ONCE_AUTH)
       VALUES (:1, :2, 'O', 'A', 1, :3, :4, :5, :6, 'Y')`,
      [customerNo, customerNo, makerUpper, makerDtStamp, checkerUpper, checkerDtStamp]
    );

    if (!photoMasterResult.success) {
      console.error(`[Photo] STTM_CUST_IMG_MASTER insert failed:`, photoMasterResult.error);
      // Continue — might already exist (duplicate key), try photo insert anyway
    } else {
      console.log(`[Photo] STTM_CUST_IMG_MASTER inserted for CIF: ${customerNo}`);
    }

    // 2. Insert into STTM_CUST_PHOTO (actual photo blob)
    const oracledb = require('oracledb');
    const custPhotoResult = await executeQuery(
      `INSERT INTO FCUBSPRD.STTM_CUST_IMAGE
       (CUSTOMER_NO, CIF_SIG_ID, SPECIMEN_SEQ_NO, FILE_TYPE, STATUS, SEQ_NO, IMAGE_TEXT, IMAGE)
       VALUES (:1, :2, :3, :4, 'N', 1, :5, :6)`,
      [customerNo, customerNo, specimenSeqNo, fileType, photoBase64, photoBuffer],
      {
        autoCommit: true,
        bindDefs: [
          { type: oracledb.STRING, maxSize: 20 },
          { type: oracledb.STRING, maxSize: 20 },
          { type: oracledb.STRING, maxSize: 30 },
          { type: oracledb.STRING, maxSize: 100 },
          { type: oracledb.STRING, maxSize: 4000000 },  // IMAGE_TEXT (CLOB — base64 string)
          { type: oracledb.BUFFER, maxSize: 4000000 },  // IMAGE (BLOB — binary)
        ],
      }
    );

    if (!custPhotoResult.success) {
      console.error(`[Photo] STTM_CUST_IMAGE insert failed:`, custPhotoResult.error);
      return res.status(500).json({
        success: false,
        error: `Failed to save photo: ${custPhotoResult.error}`,
      });
    }

    console.log(`[Photo] STTM_CUST_IMAGE inserted for CIF: ${customerNo} (${photoBuffer.length} bytes)`);

    res.json({
      success: true,
      message: `Customer photo saved for CIF: ${customerNo}`,
      details: {
        customerNo,
        specimenSeqNo,
        photoSizeBytes: photoBuffer.length,
        maker: makerUpper,
        checker: checkerUpper,
      },
    });
  } catch (error) {
    console.error('[Photo] Error saving customer photo:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to save customer photo',
    });
  }
});

module.exports = router;
