const oracledb = require('oracledb');

let oracleInitialized = false;
let dbConfig = null;
let useThickMode = false;

// Initialize Oracle - uses Thin mode by default (no native client needed)
// Set ORACLE_CLIENT_PATH env var to use Thick mode with Oracle Instant Client
async function initializeOracle() {
  dbConfig = {
    user: process.env.FLEXCUBE_DB_USER,
    password: process.env.FLEXCUBE_DB_PASSWORD,
    connectString: process.env.FLEXCUBE_DB_CONNECTION_STRING,
  };

  try {
    // Check if thick mode is requested
    if (process.env.ORACLE_CLIENT_PATH) {
      try {
        oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_PATH });
        useThickMode = true;
        console.log('Oracle Thick mode initialized with client:', process.env.ORACLE_CLIENT_PATH);
      } catch (err) {
        console.warn('Thick mode failed, falling back to Thin mode:', err.message);
      }
    } else {
      console.log('Oracle Thin mode (no client library required)');
    }

    // Create connection pool
    try {
      await oracledb.createPool({
        ...dbConfig,
        poolMin: 2,
        poolMax: 10,
        poolIncrement: 2
      });
      oracleInitialized = true;
      console.log('Oracle connection pool created successfully');
    } catch (err) {
      console.error('Pool creation error:', err.message);
      console.warn('Oracle database features may not work correctly');
    }
  } catch (err) {
    console.error('Oracle initialization error:', err.message);
    console.warn('Oracle features will be disabled');
  }
}

// Get connection from pool
async function getConnection() {
  if (!oracleInitialized) {
    throw new Error('Oracle not initialized');
  }
  try {
    const connection = await oracledb.getConnection();
    return connection;
  } catch (err) {
    console.error('Error getting database connection:', err);
    throw err;
  }
}

// Execute a query with parameters
async function executeQuery(query, params = [], options = {}) {
  if (!oracleInitialized) {
    return {
      success: false,
      error: 'Oracle not initialized'
    };
  }

  let connection;

  try {
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    oracledb.fetchAsString = [oracledb.CLOB];
    oracledb.fetchAsBuffer = [oracledb.BLOB];

    connection = await getConnection();

    const queryUpper = query.trim().toUpperCase();
    const isDML = queryUpper.startsWith('INSERT') ||
                  queryUpper.startsWith('UPDATE') ||
                  queryUpper.startsWith('DELETE') ||
                  queryUpper.startsWith('MERGE');

    const result = await connection.execute(
      query,
      params,
      {
        maxRows: 1000,
        autoCommit: isDML,
        ...options
      }
    );

    return {
      success: true,
      data: result.rows || [],
      rowsAffected: result.rowsAffected || 0
    };

  } catch (error) {
    console.error('Database query error:', error);
    return {
      success: false,
      error: error.message
    };
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }
}

// Close pool on shutdown
async function closePool() {
  try {
    await oracledb.getPool().close(10);
  } catch (err) {
    console.error('Error closing pool:', err);
  }
}

module.exports = {
  initializeOracle,
  executeQuery,
  closePool
};
