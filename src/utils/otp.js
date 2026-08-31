const crypto = require("crypto");

// 6-digit numeric code — easy to type on a phone, short-lived, single-use.
function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

module.exports = { generateOtp, hashOtp };
