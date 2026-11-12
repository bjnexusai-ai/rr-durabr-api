const crypto = require("crypto");

const sha512 = (s) => crypto.createHash("sha512").update(s).digest("hex");
const fmtAmount = (a) => Number(a).toFixed(2);
const genTxnId = () => "RRD" + Date.now() + Math.floor(Math.random() * 1000);

function requestHash(p) {
  const { PAYU_KEY, PAYU_SALT } = process.env;
  const str = [
    PAYU_KEY, p.txnid, p.amount, p.productinfo, p.firstname, p.email,
    p.udf1 || "", p.udf2 || "", p.udf3 || "", p.udf4 || "", p.udf5 || "",
    "", "", "", "", "", PAYU_SALT,
  ].join("|");
  return sha512(str);
}

function responseHash(p) {
  const { PAYU_KEY, PAYU_SALT } = process.env;
  const parts = [
    PAYU_SALT, p.status, "", "", "", "", "",
    p.udf5 || "", p.udf4 || "", p.udf3 || "", p.udf2 || "", p.udf1 || "",
    p.email, p.firstname, p.productinfo, p.amount, p.txnid, PAYU_KEY,
  ];
  if (p.additionalCharges) parts.unshift(p.additionalCharges);
  return sha512(parts.join("|"));
}

function verifyResponse(p) {
  const expected = Buffer.from(responseHash(p));
  const got = Buffer.from(String(p.hash || ""));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

module.exports = { fmtAmount, genTxnId, requestHash, responseHash, verifyResponse };
