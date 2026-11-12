const required = ["PAYU_KEY", "PAYU_SALT", "PAYU_BASE_URL", "API_PUBLIC_URL", "FRONTEND_URL"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing env vars:", missing.join(", "));
  process.exit(1);
}
console.log("PayU env OK");
