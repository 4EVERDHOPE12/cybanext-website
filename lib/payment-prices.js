const USD_GHS_RATE = Number(process.env.USD_GHS_RATE || '11.55');

if (!Number.isFinite(USD_GHS_RATE) || USD_GHS_RATE <= 0) {
  throw new Error('USD_GHS_RATE must be a positive number.');
}

function usdToGhsPesewas(usdAmount) {
  return Math.round(usdAmount * USD_GHS_RATE * 100);
}

function createUsdReferencePrice(referenceAmount) {
  const paystackAmount = usdToGhsPesewas(referenceAmount);

  return {
    referenceAmount,
    referenceCurrency: 'USD',
    chargeAmountGhs: paystackAmount / 100,
    paystackAmount,
    paystackCurrency: 'GHS',
    pricingOption: 'USD_REFERENCE',
    exchangeRate: USD_GHS_RATE,
    channels: ['card', 'mobile_money']
  };
}

const REGULAR_TRACKS = [
  'incident_response',
  'soc_analyst',
  'network_security',
  'web_app_penetration_testing',
  'cloud_security'
];

const TRACK_PRICES = Object.fromEntries(
  REGULAR_TRACKS.map((track) => [track, createUsdReferencePrice(30)])
);

const DIGITAL_FORENSICS_PRICES = {
  GHS: {
    referenceAmount: 1200,
    referenceCurrency: 'GHS',
    chargeAmountGhs: 1200,
    paystackAmount: 120000,
    paystackCurrency: 'GHS',
    pricingOption: 'GHS',
    channels: ['card', 'mobile_money']
  },
  USD_REFERENCE: createUsdReferencePrice(120)
};

function getPaymentPrice(track, pricingOption = 'USD_REFERENCE') {
  if (track === 'digital_forensics') {
    return Object.prototype.hasOwnProperty.call(
      DIGITAL_FORENSICS_PRICES,
      pricingOption
    )
      ? DIGITAL_FORENSICS_PRICES[pricingOption]
      : null;
  }

  return Object.prototype.hasOwnProperty.call(TRACK_PRICES, track)
    ? TRACK_PRICES[track]
    : null;
}

module.exports = {
  DIGITAL_FORENSICS_PRICES,
  REGULAR_TRACKS,
  TRACK_PRICES,
  USD_GHS_RATE,
  getPaymentPrice,
  usdToGhsPesewas
};
