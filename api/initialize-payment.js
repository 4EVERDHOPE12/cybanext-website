const https = require('https');

const TRACK_PRICES = {
  incident_response: {
    amount: 3000,
    currency: 'USD'
  },

  soc_analyst: {
    amount: 3000,
    currency: 'USD'
  },

  network_security: {
    amount: 3000,
    currency: 'USD'
  },

  web_app_penetration_testing: {
    amount: 3000,
    currency: 'USD'
  },

  cloud_security: {
    amount: 3000,
    currency: 'USD'
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


function initializePaystackTransaction(data) {
  return new Promise((resolve, reject) => {

    const payload = JSON.stringify(data);

    const request = https.request(
      {
        hostname: 'api.paystack.co',

        path: '/transaction/initialize',

        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,

          'Content-Type':
            'application/json',

          'Content-Length':
            Buffer.byteLength(payload)
        }
      },

      (response) => {

        let body = '';

        response.on('data', (chunk) => {
          body += chunk;
        });

        response.on('end', () => {

          try {

            const result =
              JSON.parse(body);

            if (
              !response.statusCode ||
              response.statusCode >= 400
            ) {

              return reject(
                new Error(
                  result.message ||
                  'Paystack transaction initialization failed.'
                )
              );

            }

            resolve(result);

          } catch (error) {

            reject(
              new Error(
                'Invalid response received from Paystack.'
              )
            );

          }

        });

      }
    );

    request.on('error', reject);

    request.write(payload);

    request.end();
  });
}


module.exports = async (req, res) => {

  if (req.method !== 'POST') {

    return res.status(405).json({
      error: 'Method not allowed.'
    });

  }


  if (!process.env.PAYSTACK_SECRET_KEY) {

    console.error(
      'PAYSTACK_SECRET_KEY is not configured.'
    );

    return res.status(500).json({
      error: 'Payment service is not configured.'
    });

  }


  try {

    const {
      email,
      name,
      track,
      currency
    } = req.body || {};


    if (!email || !track) {

      return res.status(400).json({
        error: 'Email and track are required.'
      });

    }


    let price;


    /* =========================================
       DIGITAL FORENSICS
    ========================================== */

    if (track === 'digital_forensics') {

  if (!currency || !DIGITAL_FORENSICS_PRICES[currency]) {

    return res.status(400).json({
      error: 'Invalid payment currency.'
    });

  }

  price =
    DIGITAL_FORENSICS_PRICES[currency];

}

    /* =========================================
       FIVE $30 TRACKS
    ========================================== */

    else {

      price = TRACK_PRICES[track];

    }


    if (!price) {

      return res.status(400).json({
        error: 'Invalid internship track.'
      });

    }


    /* =========================================
       PAYMENT REFERENCE
    ========================================== */

    const reference =
      `CYB-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase()}`;


    /* =========================================
       PAYSTACK INITIALIZATION
    ========================================== */

    const transaction =
      await initializePaystackTransaction({

        email,

        amount: price.amount,

        currency: price.currency,

        reference,

        channels: price.channels ||
          ['card'],

        metadata: {
          applicant_name:
            name || '',

          track,

          selected_currency:
            price.currency
        },

        callback_url:
          `${process.env.SITE_URL || 'https://cybanext-website.vercel.app'}/payment/success.html`

      });


    if (
      !transaction.status ||
      !transaction.data
    ) {

      return res.status(502).json({
        error: 'Unable to start the payment.'
      });

    }


    return res.status(200).json({

      accessCode:
        transaction.data.access_code,

      reference:
        transaction.data.reference

    });


  } catch (error) {

    console.error(
      'Paystack initialization error:',
      error
    );

    return res.status(500).json({

      error:
        'We could not start your payment. Please try again.'

    });

  }

};