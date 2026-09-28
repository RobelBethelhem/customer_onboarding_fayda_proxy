const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  // Action Type
  action: {
    type: String,
    enum: ['CREATE_REQUEST', 'APPROVE_REQUEST', 'REJECT_REQUEST', 'UPDATE_FLEXCUBE', 'ADMIN_LOGIN', 'ADMIN_LOGOUT', 'HARMONIZE_REQUEST', 'APPROVE_ALL', 'HARMONIZE_FIELD', 'REVERT_FIELD'],
    required: true,
    index: true
  },

  // Reference to Harmonization Request
  requestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'HarmonizationRequest'
  },

  // Who performed the action
  performedBy: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    userName: String,
    userRole: String,
    ipAddress: String
  },

  // Account/Customer Info
  accountNumber: String,
  customerNumber: String,

  // Details of the action
  details: {
    type: mongoose.Schema.Types.Mixed
  },

  // Before and After for data changes
  beforeData: {
    type: mongoose.Schema.Types.Mixed
  },
  afterData: {
    type: mongoose.Schema.Types.Mixed
  },

  // Status changes
  statusChange: {
    from: String,
    to: String
  },

  // Timestamp
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }

}, {
  timestamps: true
});

// Indexes for efficient querying
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ 'performedBy.userId': 1, timestamp: -1 });
auditLogSchema.index({ requestId: 1, timestamp: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
