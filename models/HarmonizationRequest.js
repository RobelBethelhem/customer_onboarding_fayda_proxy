const mongoose = require('mongoose');

const harmonizationRequestSchema = new mongoose.Schema({
  // Account Information
  accountNumber: {
    type: String,
    required: true,
    index: true
  },
  customerNumber: {
    type: String,
    required: true,
    index: true
  },

  // Fayda Data
  faydaData: {
    uin: String,
    fullName: {
      eng: String,
      amh: String
    },
    dateOfBirth: String,
    gender: {
      eng: String,
      amh: String
    },
    phone: String,
    email: String,
    region: {
      eng: String,
      amh: String
    },
    zone: {
      eng: String,
      amh: String
    },
    woreda: {
      eng: String,
      amh: String
    },
    residenceStatus: {
      eng: String,
      amh: String
    },
    photo: String
  },

  // FlexCube Data (before harmonization)
  flexcubeData: {
    customerNo: String,
    firstName: String,
    middleName: String,
    lastName: String,
    fullName: String,
    dateOfBirth: String,
    sex: String,
    mobileNumber: String,
    email: String,
    nationalId: String,
    residentStatus: String,
    permanentAddress1: String,
    permanentAddress2: String,
    permanentAddress3: String,
    permanentAddress4: String,
    country: String,
    motherMaidenName: String,
    placeOfBirth: String,
    birthCountry: String
  },

  // Status
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },

  // Requester Info (from Fayda verification)
  requestedBy: {
    fcn: String,
    phone: String,
    requestedAt: {
      type: Date,
      default: Date.now
    }
  },

  // Approval Info
  approvedBy: {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    adminName: String,
    approvedAt: Date,
    notes: String
  },

  // Changes Made (for audit)
  changesMade: [{
    field: String,
    oldValue: String,
    newValue: String
  }]

}, {
  timestamps: true
});

// Index for efficient queries
harmonizationRequestSchema.index({ status: 1, createdAt: -1 });
harmonizationRequestSchema.index({ accountNumber: 1, status: 1 });

module.exports = mongoose.model('HarmonizationRequest', harmonizationRequestSchema);
