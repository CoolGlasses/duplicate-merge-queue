'use strict';
const { hashPassword } = require('./auth');
const pw = process.argv[2];
if (!pw) {
  console.error('usage: npm run hash-password -- <password>');
  process.exit(1);
}
console.log(hashPassword(pw));
