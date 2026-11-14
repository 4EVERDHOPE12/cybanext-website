const PAYSTACK_SECRET_KEY_PATTERN =
  /^sk_(test|live)_[A-Za-z0-9][A-Za-z0-9_-]*$/;

function getPaystackSecretKeyMode(secretKey) {
  if (typeof secretKey !== 'string' || secretKey.trim() !== secretKey) {
    return null;
  }

  const match = PAYSTACK_SECRET_KEY_PATTERN.exec(secretKey);
  return match ? match[1] : null;
}

module.exports = {
  getPaystackSecretKeyMode
};
