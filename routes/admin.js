const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const HarmonizationRequest = require('../models/HarmonizationRequest');
const AuditLog = require('../models/AuditLog');
const auth = require('../middleware/auth');
const { executeQuery } = require('../lib/oracleDb');

// Helper: normalize string for comparison (lowercase, trim)
const normalize = (str) => (str || '').toString().toLowerCase().trim();

// Helper: check if values match (case-insensitive)
const valuesMatch = (val1, val2) => normalize(val1) === normalize(val2);

// Admin Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const user = await User.findOne({ username: username.toLowerCase() });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    await AuditLog.create({
      action: 'ADMIN_LOGIN',
      performedBy: {
        userId: user._id,
        userName: user.fullName,
        userRole: user.role,
        ipAddress: req.ip
      },
      timestamp: new Date()
    });

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        role: user.role
      }
    });

  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ message: 'Login failed' });
  }
});

// Get all harmonization requests
router.get('/requests', auth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const [requests, total] = await Promise.all([
      HarmonizationRequest.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      HarmonizationRequest.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: requests,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total
      }
    });

  } catch (error) {
    console.error('Get requests error:', error);
    res.status(500).json({ message: 'Failed to get requests' });
  }
});

// Get single request with comparison data
router.get('/requests/:id', auth, async (req, res) => {
  try {
    const request = await HarmonizationRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    const fayda = request.faydaData || {};
    const flex = request.flexcubeData || {};

    // Parse Fayda full name into parts
    const faydaNameParts = (fayda.fullName?.eng || '').split(' ').filter(Boolean);
    const faydaFirstName = faydaNameParts[0] || '';
    const faydaMiddleName = faydaNameParts[1] || '';
    const faydaLastName = faydaNameParts.slice(2).join(' ') || faydaNameParts[2] || '';

    // Build comparison fields
    const comparisonFields = [
      {
        key: 'firstName',
        label: 'First Name',
        faydaValue: faydaFirstName,
        flexValue: flex.firstName || '',
        dbColumn: 'FIRST_NAME',
        canUpdate: !!faydaFirstName && !valuesMatch(faydaFirstName, flex.firstName)
      },
      {
        key: 'middleName',
        label: 'Middle Name',
        faydaValue: faydaMiddleName,
        flexValue: flex.middleName || '',
        dbColumn: 'MIDDLE_NAME',
        canUpdate: !!faydaMiddleName && !valuesMatch(faydaMiddleName, flex.middleName)
      },
      {
        key: 'lastName',
        label: 'Last Name',
        faydaValue: faydaLastName,
        flexValue: flex.lastName || '',
        dbColumn: 'LAST_NAME',
        canUpdate: !!faydaLastName && !valuesMatch(faydaLastName, flex.lastName)
      },
      {
        key: 'dateOfBirth',
        label: 'Date of Birth',
        faydaValue: fayda.dateOfBirth || '',
        flexValue: flex.dateOfBirth || '',
        dbColumn: 'DATE_OF_BIRTH',
        canUpdate: !!fayda.dateOfBirth && !valuesMatch(fayda.dateOfBirth, flex.dateOfBirth)
      },
      {
        key: 'gender',
        label: 'Gender',
        faydaValue: fayda.gender?.eng || '',
        flexValue: flex.sex === 'M' ? 'Male' : flex.sex === 'F' ? 'Female' : flex.sex || '',
        faydaDbValue: fayda.gender?.eng === 'Male' ? 'M' : fayda.gender?.eng === 'Female' ? 'F' : '',
        dbColumn: 'SEX',
        canUpdate: !!fayda.gender?.eng && !valuesMatch(
          fayda.gender?.eng === 'Male' ? 'M' : 'F',
          flex.sex
        )
      },
      {
        key: 'nationalId',
        label: 'National ID (UIN)',
        faydaValue: fayda.uin || '',
        flexValue: flex.nationalId || '',
        dbColumn: 'P_NATIONAL_ID',
        canUpdate: !!fayda.uin && !valuesMatch(fayda.uin, flex.nationalId)
      },
      {
        key: 'phone',
        label: 'Phone',
        faydaValue: fayda.phone || '',
        flexValue: flex.phone || '',
        dbColumn: null, // Phone is NOT updated
        canUpdate: false,
        noUpdate: true
      },
      {
        key: 'email',
        label: 'Email',
        faydaValue: fayda.email || '',
        flexValue: flex.email || '',
        dbColumn: 'E_MAIL',
        canUpdate: !!fayda.email && !valuesMatch(fayda.email, flex.email)
      },
      {
        key: 'region',
        label: 'Region (Address 1)',
        faydaValue: fayda.region?.eng || '',
        flexValue: flex.permanentAddress1 || '',
        dbColumn: 'P_ADDRESS1',
        canUpdate: !!fayda.region?.eng && !valuesMatch(fayda.region?.eng, flex.permanentAddress1)
      },
      {
        key: 'zone',
        label: 'Zone (Address 2)',
        faydaValue: fayda.zone?.eng || '',
        flexValue: flex.permanentAddress2 || '',
        dbColumn: 'P_ADDRESS2',
        canUpdate: !!fayda.zone?.eng && !valuesMatch(fayda.zone?.eng, flex.permanentAddress2)
      },
      {
        key: 'woreda',
        label: 'Woreda (Address 3)',
        faydaValue: fayda.woreda?.eng || '',
        flexValue: flex.permanentAddress3 || '',
        dbColumn: 'P_ADDRESS3',
        canUpdate: !!fayda.woreda?.eng && !valuesMatch(fayda.woreda?.eng, flex.permanentAddress3)
      },
      {
        key: 'country',
        label: 'Country',
        faydaValue: fayda.residenceStatus?.eng || '',
        flexValue: flex.country || '',
        dbColumn: 'P_COUNTRY',
        canUpdate: !!fayda.residenceStatus?.eng && !valuesMatch(fayda.residenceStatus?.eng, flex.country)
      }
    ];

    // Add match status to each field
    comparisonFields.forEach(field => {
      field.isMatch = valuesMatch(field.faydaValue, field.flexValue);
    });

    res.json({
      success: true,
      data: {
        ...request.toObject(),
        comparisonFields,
        photo: fayda.photo || null
      }
    });

  } catch (error) {
    console.error('Get request detail error:', error);
    res.status(500).json({ message: 'Failed to get request' });
  }
});

// Harmonize selected fields (works for pending and approved requests)
router.post('/requests/:id/harmonize', auth, async (req, res) => {
  try {
    const { selectedFields, notes } = req.body;
    const request = await HarmonizationRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    if (request.status === 'rejected') {
      return res.status(400).json({ message: 'Cannot harmonize rejected request' });
    }

    if (!selectedFields || selectedFields.length === 0) {
      return res.status(400).json({ message: 'No fields selected for harmonization' });
    }

    const wasPending = request.status === 'pending';

    const fayda = request.faydaData || {};
    const flex = request.flexcubeData || {};
    const faydaNameParts = (fayda.fullName?.eng || '').split(' ').filter(Boolean);

    // Field mapping
    const fieldConfig = {
      firstName: { value: faydaNameParts[0], dbColumn: 'FIRST_NAME', label: 'First Name', oldValue: flex.firstName },
      middleName: { value: faydaNameParts[1], dbColumn: 'MIDDLE_NAME', label: 'Middle Name', oldValue: flex.middleName },
      lastName: { value: faydaNameParts.slice(2).join(' ') || faydaNameParts[2], dbColumn: 'LAST_NAME', label: 'Last Name', oldValue: flex.lastName },
      dateOfBirth: { value: fayda.dateOfBirth, dbColumn: 'DATE_OF_BIRTH', label: 'Date of Birth', oldValue: flex.dateOfBirth },
      gender: { value: fayda.gender?.eng === 'Male' ? 'M' : fayda.gender?.eng === 'Female' ? 'F' : null, dbColumn: 'SEX', label: 'Gender', oldValue: flex.sex },
      nationalId: { value: fayda.uin, dbColumn: 'P_NATIONAL_ID', label: 'National ID', oldValue: flex.nationalId },
      email: { value: fayda.email, dbColumn: 'E_MAIL', label: 'Email', oldValue: flex.email },
      region: { value: fayda.region?.eng, dbColumn: 'P_ADDRESS1', label: 'Region', oldValue: flex.permanentAddress1 },
      zone: { value: fayda.zone?.eng, dbColumn: 'P_ADDRESS2', label: 'Zone', oldValue: flex.permanentAddress2 },
      woreda: { value: fayda.woreda?.eng, dbColumn: 'P_ADDRESS3', label: 'Woreda', oldValue: flex.permanentAddress3 },
      country: { value: fayda.residenceStatus?.eng, dbColumn: 'P_COUNTRY', label: 'Country', oldValue: flex.country }
    };

    const updateFields = [];
    const params = [];
    const changesMade = [];
    let paramIndex = 1;

    for (const fieldKey of selectedFields) {
      const config = fieldConfig[fieldKey];
      if (config && config.value && config.dbColumn) {
        // Only update if Fayda has data
        updateFields.push(`${config.dbColumn} = :${paramIndex}`);
        params.push(config.value);
        changesMade.push({
          field: config.label,
          oldValue: config.oldValue || '',
          newValue: config.value
        });
        paramIndex++;
      }
    }

    if (updateFields.length > 0) {
      params.push(request.customerNumber);

      const updateQuery = `
        UPDATE FCUBSPRD.STTM_CUST_PERSONAL
        SET ${updateFields.join(', ')}
        WHERE CUSTOMER_NO = :${paramIndex}
      `;

      const updateResult = await executeQuery(updateQuery, params);

      if (!updateResult.success) {
        return res.status(500).json({
          message: 'Failed to update FlexCube database',
          error: updateResult.error
        });
      }

      // Also update local MongoDB flexcubeData to reflect changes
      const mongoFieldMap = {
        firstName: 'firstName',
        middleName: 'middleName',
        lastName: 'lastName',
        dateOfBirth: 'dateOfBirth',
        gender: 'sex',
        nationalId: 'nationalId',
        email: 'email',
        region: 'permanentAddress1',
        zone: 'permanentAddress2',
        woreda: 'permanentAddress3',
        country: 'country'
      };

      for (const fieldKey of selectedFields) {
        const config = fieldConfig[fieldKey];
        const mongoField = mongoFieldMap[fieldKey];
        if (config && config.value && mongoField) {
          request.flexcubeData[mongoField] = config.value;
        }
      }
    }

    // Update request status (only change to approved if was pending)
    if (wasPending) {
      request.status = 'approved';
      request.approvedBy = {
        adminId: req.user._id,
        adminName: req.user.fullName,
        approvedAt: new Date(),
        notes
      };
    }

    // Append new changes to existing changesMade
    const existingChanges = request.changesMade || [];
    request.changesMade = [...existingChanges, ...changesMade];

    await request.save();

    // Create audit log
    await AuditLog.create({
      action: wasPending ? 'HARMONIZE_REQUEST' : 'HARMONIZE_FIELD',
      requestId: request._id,
      accountNumber: request.accountNumber,
      customerNumber: request.customerNumber,
      performedBy: {
        userId: req.user._id,
        userName: req.user.fullName,
        userRole: req.user.role,
        ipAddress: req.ip
      },
      beforeData: request.flexcubeData,
      afterData: changesMade.reduce((acc, c) => ({ ...acc, [c.field]: c.newValue }), {}),
      statusChange: wasPending ? { from: 'pending', to: 'approved' } : null,
      details: {
        selectedFields,
        changesCount: changesMade.length,
        changes: changesMade,
        notes,
        additionalHarmonization: !wasPending
      },
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: `Harmonized ${changesMade.length} field(s) successfully`,
      changesMade,
      requestId: request._id,
      additionalHarmonization: !wasPending
    });

  } catch (error) {
    console.error('Harmonize request error:', error);
    res.status(500).json({ message: 'Failed to harmonize', error: error.message });
  }
});

// Approve all (harmonize all fields at once)
router.post('/requests/:id/approve', auth, async (req, res) => {
  try {
    const { notes } = req.body;
    const request = await HarmonizationRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request is not pending' });
    }

    const fayda = request.faydaData || {};
    const flex = request.flexcubeData || {};
    const faydaNameParts = (fayda.fullName?.eng || '').split(' ').filter(Boolean);

    const changesMade = [];
    const updateFields = [];
    const params = [];
    let paramIndex = 1;

    // First Name
    if (faydaNameParts[0] && !valuesMatch(faydaNameParts[0], flex.firstName)) {
      updateFields.push(`FIRST_NAME = :${paramIndex++}`);
      params.push(faydaNameParts[0]);
      changesMade.push({ field: 'First Name', oldValue: flex.firstName, newValue: faydaNameParts[0] });
    }

    // Middle Name
    if (faydaNameParts[1] && !valuesMatch(faydaNameParts[1], flex.middleName)) {
      updateFields.push(`MIDDLE_NAME = :${paramIndex++}`);
      params.push(faydaNameParts[1]);
      changesMade.push({ field: 'Middle Name', oldValue: flex.middleName, newValue: faydaNameParts[1] });
    }

    // Last Name
    const lastName = faydaNameParts.slice(2).join(' ') || faydaNameParts[2];
    if (lastName && !valuesMatch(lastName, flex.lastName)) {
      updateFields.push(`LAST_NAME = :${paramIndex++}`);
      params.push(lastName);
      changesMade.push({ field: 'Last Name', oldValue: flex.lastName, newValue: lastName });
    }

    // Date of Birth
    if (fayda.dateOfBirth && !valuesMatch(fayda.dateOfBirth, flex.dateOfBirth)) {
      updateFields.push(`DATE_OF_BIRTH = :${paramIndex++}`);
      params.push(fayda.dateOfBirth);
      changesMade.push({ field: 'Date of Birth', oldValue: flex.dateOfBirth, newValue: fayda.dateOfBirth });
    }

    // Gender
    if (fayda.gender?.eng) {
      const faydaSex = fayda.gender.eng === 'Male' ? 'M' : 'F';
      if (!valuesMatch(faydaSex, flex.sex)) {
        updateFields.push(`SEX = :${paramIndex++}`);
        params.push(faydaSex);
        changesMade.push({ field: 'Gender', oldValue: flex.sex, newValue: faydaSex });
      }
    }

    // Email
    if (fayda.email && !valuesMatch(fayda.email, flex.email)) {
      updateFields.push(`E_MAIL = :${paramIndex++}`);
      params.push(fayda.email);
      changesMade.push({ field: 'Email', oldValue: flex.email, newValue: fayda.email });
    }

    // National ID
    if (fayda.uin && !valuesMatch(fayda.uin, flex.nationalId)) {
      updateFields.push(`P_NATIONAL_ID = :${paramIndex++}`);
      params.push(fayda.uin);
      changesMade.push({ field: 'National ID', oldValue: flex.nationalId, newValue: fayda.uin });
    }

    // Region -> P_ADDRESS1
    if (fayda.region?.eng && !valuesMatch(fayda.region.eng, flex.permanentAddress1)) {
      updateFields.push(`P_ADDRESS1 = :${paramIndex++}`);
      params.push(fayda.region.eng);
      changesMade.push({ field: 'Region', oldValue: flex.permanentAddress1, newValue: fayda.region.eng });
    }

    // Zone -> P_ADDRESS2
    if (fayda.zone?.eng && !valuesMatch(fayda.zone.eng, flex.permanentAddress2)) {
      updateFields.push(`P_ADDRESS2 = :${paramIndex++}`);
      params.push(fayda.zone.eng);
      changesMade.push({ field: 'Zone', oldValue: flex.permanentAddress2, newValue: fayda.zone.eng });
    }

    // Woreda -> P_ADDRESS3
    if (fayda.woreda?.eng && !valuesMatch(fayda.woreda.eng, flex.permanentAddress3)) {
      updateFields.push(`P_ADDRESS3 = :${paramIndex++}`);
      params.push(fayda.woreda.eng);
      changesMade.push({ field: 'Woreda', oldValue: flex.permanentAddress3, newValue: fayda.woreda.eng });
    }

    // Residence Status -> P_COUNTRY
    if (fayda.residenceStatus?.eng && !valuesMatch(fayda.residenceStatus.eng, flex.country)) {
      updateFields.push(`P_COUNTRY = :${paramIndex++}`);
      params.push(fayda.residenceStatus.eng);
      changesMade.push({ field: 'Country', oldValue: flex.country, newValue: fayda.residenceStatus.eng });
    }

    // Update FlexCube
    if (updateFields.length > 0) {
      params.push(request.customerNumber);
      const updateQuery = `
        UPDATE FCUBSPRD.STTM_CUST_PERSONAL
        SET ${updateFields.join(', ')}
        WHERE CUSTOMER_NO = :${paramIndex}
      `;

      const updateResult = await executeQuery(updateQuery, params);
      if (!updateResult.success) {
        return res.status(500).json({ message: 'Failed to update FlexCube', error: updateResult.error });
      }

      // Also update local MongoDB flexcubeData to reflect changes
      for (const change of changesMade) {
        const fieldMongoMap = {
          'First Name': 'firstName',
          'Middle Name': 'middleName',
          'Last Name': 'lastName',
          'Date of Birth': 'dateOfBirth',
          'Gender': 'sex',
          'National ID': 'nationalId',
          'Email': 'email',
          'Region': 'permanentAddress1',
          'Zone': 'permanentAddress2',
          'Woreda': 'permanentAddress3',
          'Country': 'country'
        };
        const mongoField = fieldMongoMap[change.field];
        if (mongoField) {
          request.flexcubeData[mongoField] = change.newValue;
        }
      }
    }

    request.status = 'approved';
    request.approvedBy = { adminId: req.user._id, adminName: req.user.fullName, approvedAt: new Date(), notes };
    request.changesMade = changesMade;
    await request.save();

    await AuditLog.create({
      action: 'APPROVE_ALL',
      requestId: request._id,
      accountNumber: request.accountNumber,
      customerNumber: request.customerNumber,
      performedBy: { userId: req.user._id, userName: req.user.fullName, userRole: req.user.role, ipAddress: req.ip },
      beforeData: request.flexcubeData,
      afterData: changesMade.reduce((acc, c) => ({ ...acc, [c.field]: c.newValue }), {}),
      statusChange: { from: 'pending', to: 'approved' },
      details: { changesCount: changesMade.length, changes: changesMade, notes },
      timestamp: new Date()
    });

    res.json({ success: true, message: 'All fields harmonized', changesMade, requestId: request._id });

  } catch (error) {
    console.error('Approve request error:', error);
    res.status(500).json({ message: 'Failed to approve', error: error.message });
  }
});

// Reject
router.post('/requests/:id/reject', auth, async (req, res) => {
  try {
    const { notes } = req.body;
    const request = await HarmonizationRequest.findById(req.params.id);

    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ message: 'Request is not pending' });

    request.status = 'rejected';
    request.approvedBy = { adminId: req.user._id, adminName: req.user.fullName, approvedAt: new Date(), notes };
    await request.save();

    await AuditLog.create({
      action: 'REJECT_REQUEST',
      requestId: request._id,
      accountNumber: request.accountNumber,
      customerNumber: request.customerNumber,
      performedBy: { userId: req.user._id, userName: req.user.fullName, userRole: req.user.role, ipAddress: req.ip },
      statusChange: { from: 'pending', to: 'rejected' },
      details: { notes },
      timestamp: new Date()
    });

    res.json({ success: true, message: 'Request rejected', requestId: request._id });

  } catch (error) {
    console.error('Reject request error:', error);
    res.status(500).json({ message: 'Failed to reject request' });
  }
});

// Revert selected fields to original values
router.post('/requests/:id/revert', auth, async (req, res) => {
  try {
    const { selectedFields, notes } = req.body;
    const request = await HarmonizationRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    if (!selectedFields || selectedFields.length === 0) {
      return res.status(400).json({ message: 'No fields selected for reverting' });
    }

    // Find original values from changesMade
    const changesMade = request.changesMade || [];
    const revertChanges = [];
    const updateFields = [];
    const params = [];
    let paramIndex = 1;

    // Field to DB column mapping
    const fieldDbMap = {
      'First Name': 'FIRST_NAME',
      'Middle Name': 'MIDDLE_NAME',
      'Last Name': 'LAST_NAME',
      'Date of Birth': 'DATE_OF_BIRTH',
      'Gender': 'SEX',
      'National ID': 'P_NATIONAL_ID',
      'Email': 'E_MAIL',
      'Region': 'P_ADDRESS1',
      'Zone': 'P_ADDRESS2',
      'Woreda': 'P_ADDRESS3',
      'Country': 'P_COUNTRY'
    };

    // Field to MongoDB mapping
    const fieldMongoMap = {
      'First Name': 'firstName',
      'Middle Name': 'middleName',
      'Last Name': 'lastName',
      'Date of Birth': 'dateOfBirth',
      'Gender': 'sex',
      'National ID': 'nationalId',
      'Email': 'email',
      'Region': 'permanentAddress1',
      'Zone': 'permanentAddress2',
      'Woreda': 'permanentAddress3',
      'Country': 'country'
    };

    for (const fieldName of selectedFields) {
      // Find the change for this field
      const change = changesMade.find(c => c.field === fieldName);
      if (change && fieldDbMap[fieldName]) {
        updateFields.push(`${fieldDbMap[fieldName]} = :${paramIndex}`);
        params.push(change.oldValue || '');
        revertChanges.push({
          field: fieldName,
          oldValue: change.newValue, // current value
          newValue: change.oldValue || '' // reverting to original
        });
        paramIndex++;
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ message: 'No valid fields to revert' });
    }

    // Update FlexCube
    params.push(request.customerNumber);
    const updateQuery = `
      UPDATE FCUBSPRD.STTM_CUST_PERSONAL
      SET ${updateFields.join(', ')}
      WHERE CUSTOMER_NO = :${paramIndex}
    `;

    const updateResult = await executeQuery(updateQuery, params);
    if (!updateResult.success) {
      return res.status(500).json({ message: 'Failed to revert in FlexCube', error: updateResult.error });
    }

    // Update local MongoDB flexcubeData
    for (const revert of revertChanges) {
      const mongoField = fieldMongoMap[revert.field];
      if (mongoField) {
        request.flexcubeData[mongoField] = revert.newValue;
      }
    }

    // Remove reverted changes from changesMade
    request.changesMade = changesMade.filter(c => !selectedFields.includes(c.field));

    await request.save();

    // Create audit log
    await AuditLog.create({
      action: 'REVERT_FIELD',
      requestId: request._id,
      accountNumber: request.accountNumber,
      customerNumber: request.customerNumber,
      performedBy: {
        userId: req.user._id,
        userName: req.user.fullName,
        userRole: req.user.role,
        ipAddress: req.ip
      },
      beforeData: revertChanges.reduce((acc, c) => ({ ...acc, [c.field]: c.oldValue }), {}),
      afterData: revertChanges.reduce((acc, c) => ({ ...acc, [c.field]: c.newValue }), {}),
      details: {
        revertedFields: selectedFields,
        changesCount: revertChanges.length,
        changes: revertChanges,
        notes
      },
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: `Reverted ${revertChanges.length} field(s) to original values`,
      revertChanges,
      requestId: request._id
    });

  } catch (error) {
    console.error('Revert request error:', error);
    res.status(500).json({ message: 'Failed to revert', error: error.message });
  }
});

// Get audit logs
router.get('/audit-logs', auth, async (req, res) => {
  try {
    const { requestId, action, page = 1, limit = 50 } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    if (requestId) query.requestId = requestId;
    if (action) query.action = action;

    const [logs, total] = await Promise.all([
      AuditLog.find(query).sort({ timestamp: -1 }).skip(skip).limit(parseInt(limit)),
      AuditLog.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: logs,
      pagination: { current: parseInt(page), pages: Math.ceil(total / limit), total }
    });

  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ message: 'Failed to get audit logs' });
  }
});

// Dashboard stats
router.get('/stats', auth, async (req, res) => {
  try {
    const [pending, approved, rejected, todayRequests] = await Promise.all([
      HarmonizationRequest.countDocuments({ status: 'pending' }),
      HarmonizationRequest.countDocuments({ status: 'approved' }),
      HarmonizationRequest.countDocuments({ status: 'rejected' }),
      HarmonizationRequest.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } })
    ]);

    res.json({
      success: true,
      data: { pending, approved, rejected, total: pending + approved + rejected, todayRequests }
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ message: 'Failed to get stats' });
  }
});

// Create initial admin
router.post('/setup', async (req, res) => {
  try {
    const existingAdmin = await User.findOne({ role: 'superadmin' });
    if (existingAdmin) return res.status(400).json({ message: 'Admin already exists' });

    const admin = new User({ username: 'admin', password: 'admin123', fullName: 'System Administrator', role: 'superadmin', isActive: true });
    await admin.save();

    res.json({ success: true, message: 'Admin user created', credentials: { username: 'admin', password: 'admin123' } });

  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ message: 'Setup failed' });
  }
});

module.exports = router;
