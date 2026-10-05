/*
 Cybanext payment prices. 
 */

const USD_GHS_RATE = Number(process.env.USD_GHS_RATE || '11.55');

if (!Number.isFinite(USD_GHS_RATE) || USD_GHS_RATE <= 0) {
  throw new Error('USD_GHS_RATE must be a positive number.');
}

function usdToGhsPesewas(usdAmount) {
  return Math.round(usdAmount * USD_GHS_RATE * 100);
}

function usdToGhs(usdAmount) {
  return usdToGhsPesewas(usdAmount) / 100;
}

const TRACK_PRICES = {
  incident_response: {
    referenceAmount: 30,
    referenceCurrency: 'USD',
    amount: usdToGhsPesewas(30),
    chargeAmountGhs: usdToGhs(30),
    currency: 'GHS',
    channels: ['card', 'mobile_money']
  },
  soc_analyst: {
    referenceAmount: 30,
    referenceCurrency: 'USD',
    amount: usdToGhsPesewas(30),
    chargeAmountGhs: usdToGhs(30),
    currency: 'GHS',
    channels: ['card', 'mobile_money']
  },
  network_security: {
    referenceAmount: 30,
    referenceCurrency: 'USD',
    amount: usdToGhsPesewas(30),
    chargeAmountGhs: usdToGhs(30),
    currency: 'GHS',
    channels: ['card', 'mobile_money']
  },
  web_app_penetration_testing: {
    referenceAmount: 30,
    referenceCurrency: 'USD',
    amount: usdToGhsPesewas(30),
    chargeAmountGhs: usdToGhs(30),
    currency: 'GHS',
    channels: ['card', 'mobile_money']
  },
  cloud_security: {
    referenceAmount: 30,
    referenceCurrency: 'USD',
    amount: usdToGhsPesewas(30),
    chargeAmountGhs: usdToGhs(30),
    currency: 'GHS',
    channels: ['card', 'mobile_money']
  }
};

const DIGITAL_FORENSICS_PRICES = {
  GHS: {
    referenceAmount: 1200,
    referenceCurrency: 'GHS',
    amount: 120000,
    chargeAmountGhs: 1200,
    currency: 'GHS',
    channels: ['card', 'mobile_money']
  },
  USD: {
    referenceAmount: 120,
    referenceCurrency: 'USD',
    amount: usdToGhsPesewas(120),
    chargeAmountGhs: usdToGhs(120),
    currency: 'GHS',
    channels: ['card', 'mobile_money']
  }
};

function getPaymentPrice(track, pricingOption = 'USD') {
  if (track === 'digital_forensics') {
    return DIGITAL_FORENSICS_PRICES[pricingOption] || null;
  }

  return TRACK_PRICES[track] || null;
}

module.exports = {
  USD_GHS_RATE,
  DIGITAL_FORENSICS_PRICES,
  TRACK_PRICES,
  getPaymentPrice,
  usdToGhs,
  usdToGhsPesewas
};
