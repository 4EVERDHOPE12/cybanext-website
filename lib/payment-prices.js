const TRACK_PRICES = {
  incident_response: {
    amount: 3000,
    currency: 'USD',
    channels: ['card', 'mobile_money']
  },
  soc_analyst: {
    amount: 3000,
    currency: 'USD',
    channels: ['card', 'mobile_money']
  },
  network_security: {
    amount: 3000,
    currency: 'USD',
    channels: ['card', 'mobile_money']
  },
  web_app_penetration_testing: {
    amount: 3000,
    currency: 'USD',
    channels: ['card', 'mobile_money']
  },
  cloud_security: {
    amount: 3000,
    currency: 'USD',
    channels: ['card', 'mobile_money']
  }
};

const DIGITAL_FORENSICS_PRICES = {
  GHS: {
    amount: 120000,
    currency: 'GHS',
    channels: ['card', 'mobile_money']
  },
  USD: {
    amount: 12000,
    currency: 'USD',
    channels: ['card']
  }
};

function getPaymentPrice(track, currency) {
  if (track === 'digital_forensics') {
    return DIGITAL_FORENSICS_PRICES[currency] || null;
  }

  return TRACK_PRICES[track] || null;
}

module.exports = {
  DIGITAL_FORENSICS_PRICES,
  TRACK_PRICES,
  getPaymentPrice
};