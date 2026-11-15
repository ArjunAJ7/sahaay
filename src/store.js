// Store dispatcher: sqlite locally by default, Turso when STORE=turso (deploy).
// Both implementations expose the same async API (see store-sqlite.js).
const impl = process.env.STORE === 'turso'
  ? require('./store-turso')()
  : require('./store-sqlite');
console.log(`[sahaay] data store: ${impl.kind}`);
module.exports = impl;
