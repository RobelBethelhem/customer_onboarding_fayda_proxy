const express = require('express');
const router = express.Router();
const HarmonizationRequest = require('../models/HarmonizationRequest');
const AuditLog = require('../models/AuditLog');

// Create a new harmonization request
router.post('/request', async (req, res) => {
  try {
    const { accountNumber, customerNumber, faydaData, flexcubeData, requesterInfo } = req.body;

    // Validate required fields
    if (!accountNumber || !customerNumber || !faydaData || !flexcubeData) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Check if there's already a pending request for this account
    const existingRequest = await HarmonizationRequest.findOne({
      accountNumber,
      status: 'pending'
    });

    if (existingRequest) {
      return res.status(409).json({
        message: 'A pending harmonization request already exists for this account',
        requestId: existingRequest._id
      });
    }

    // Create new request
    const request = new HarmonizationRequest({
      accountNumber,
      customerNumber,
      faydaData,
      flexcubeData,
      status: 'pending',
      requestedBy: {
        fcn: requesterInfo?.fcn,
        phone: requesterInfo?.phone,
        requestedAt: new Date()
      }
    });

    await request.save();

    // Create audit log
    await AuditLog.create({
      action: 'CREATE_REQUEST',
      requestId: request._id,
      accountNumber,
      customerNumber,
      performedBy: {
        userName: requesterInfo?.fcn || 'Customer',
        userRole: 'customer'
      },
      details: {
        faydaUin: faydaData.uin,
        customerName: faydaData.fullName?.eng
      },
      timestamp: new Date()
    });

    res.status(201).json({
      success: true,
      message: 'Harmonization request created successfully',
      requestId: request._id,
      status: 'pending'
    });

  } catch (error) {
    console.error('Create harmonization request error:', error);
    res.status(500).json({
      message: 'Failed to create harmonization request',
      error: error.message
    });
  }
});

// Get request status by ID
router.get('/request/:id', async (req, res) => {
  try {
    const request = await HarmonizationRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    res.json({
      success: true,
      data: {
        id: request._id,
        accountNumber: request.accountNumber,
        status: request.status,
        createdAt: request.createdAt,
        approvedBy: request.approvedBy
      }
    });

  } catch (error) {
    console.error('Get request status error:', error);
    res.status(500).json({ message: 'Failed to get request status' });
  }
});

// Get requests by account number
router.get('/requests/account/:accountNumber', async (req, res) => {
  try {
    const requests = await HarmonizationRequest.find({
      accountNumber: req.params.accountNumber
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: requests
    });

  } catch (error) {
    console.error('Get requests by account error:', error);
    res.status(500).json({ message: 'Failed to get requests' });
  }
});

module.exports = router;
