const { getPaymentPrice } = require('../lib/payment-prices');

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const regularPrice = getPaymentPrice('incident_response');
  const digitalForensicsLocal =
    getPaymentPrice('digital_forensics', 'GHS');
  const digitalForensicsInternational =
    getPaymentPrice('digital_forensics', 'USD_REFERENCE');

  return res.status(200).json({
    regular: {
      referenceAmount: regularPrice.referenceAmount,
      referenceCurrency: regularPrice.referenceCurrency,
      chargeAmountGhs: regularPrice.chargeAmountGhs,
      paystackCurrency: regularPrice.paystackCurrency
    },
    digitalForensics: {
      GHS: {
        referenceAmount: digitalForensicsLocal.referenceAmount,
        referenceCurrency: digitalForensicsLocal.referenceCurrency,
        chargeAmountGhs: digitalForensicsLocal.chargeAmountGhs,
        paystackCurrency: digitalForensicsLocal.paystackCurrency
      },
      USD_REFERENCE: {
        referenceAmount: digitalForensicsInternational.referenceAmount,
        referenceCurrency: digitalForensicsInternational.referenceCurrency,
        chargeAmountGhs: digitalForensicsInternational.chargeAmountGhs,
        paystackCurrency: digitalForensicsInternational.paystackCurrency,
        exchangeRate: digitalForensicsInternational.exchangeRate
      }
    }
  });
};
