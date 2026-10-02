const https = require('https');


/* =========================================================
   EXPECTED PAYMENT VALUES
   IMPORTANT:
   These values are server-side and cannot be changed
   by the browser.
========================================================= */

const EXPECTED_PAYMENTS = {

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
  },

  digital_forensics: {
    GHS: {
      amount: 120000,
      currency: 'GHS'
    },

    USD: {
      amount: 12000,
      currency: 'USD'
    }
  }

};


/* =========================================================
   PAYSTACK VERIFY REQUEST
========================================================= */

function verifyPaystackTransaction(reference) {

  return new Promise((resolve, reject) => {

    const request = https.request(

      {
        hostname: 'api.paystack.co',

        path:
          `/transaction/verify/${encodeURIComponent(reference)}`,

        method: 'GET',

        headers: {
          Authorization:
            `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
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
                  'Paystack verification failed.'
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

    request.end();

  });

}


/* =========================================================
   API HANDLER
========================================================= */

module.exports = async (req, res) => {

  if (req.method !== 'POST') {

    return res.status(405).json({
      error: 'Method not allowed.'
    });

  }


  /* =======================================================
     SECRET KEY CHECK
  ======================================================= */

  if (!process.env.PAYSTACK_SECRET_KEY) {

    console.error(
      'PAYSTACK_SECRET_KEY is not configured.'
    );

    return res.status(500).json({
      error:
        'Payment service is not configured.'
    });

  }


  try {

    const {
      reference
    } = req.body || {};


    /* =====================================================
       REFERENCE VALIDATION
    ===================================================== */

    if (!reference) {

      return res.status(400).json({
        error:
          'Payment reference is required.'
      });

    }


    /* =====================================================
       VERIFY WITH PAYSTACK
    ===================================================== */

    const result =
      await verifyPaystackTransaction(
        reference
      );


    if (
      !result.status ||
      !result.data
    ) {

      return res.status(502).json({
        verified: false,

        error:
          'Unable to verify the payment.'
      });

    }


    const transaction =
      result.data;


    /* =====================================================
       1. VERIFY TRANSACTION STATUS
    ===================================================== */

    if (
      transaction.status !== 'success'
    ) {

      return res.status(400).json({

        verified: false,

        error:
          'The payment was not completed successfully.'

      });

    }


    /* =====================================================
       2. GET TRACK FROM METADATA
    ===================================================== */

    let metadata =
      transaction.metadata;


    /*
      Paystack may return metadata as an object
      or as a JSON string depending on the response.
    */

    if (
      typeof metadata === 'string'
    ) {

      try {

        metadata =
          JSON.parse(metadata);

      } catch (error) {

        metadata = {};

      }

    }


    const track =
      metadata?.track;


    if (!track) {

      console.error(
        'Payment verification failed: track missing from metadata.',
        reference
      );

      return res.status(400).json({

        verified: false,

        error:
          'Payment information could not be verified.'

      });

    }


    /* =====================================================
       3. DETERMINE EXPECTED PAYMENT
    ===================================================== */

    let expectedPayment;


    if (
      track === 'digital_forensics'
    ) {

      const selectedCurrency =
        metadata?.selected_currency;


      if (
        !selectedCurrency ||
        !EXPECTED_PAYMENTS.digital_forensics[
          selectedCurrency
        ]
      ) {

        return res.status(400).json({

          verified: false,

          error:
            'Payment currency could not be verified.'

        });

      }


      expectedPayment =
        EXPECTED_PAYMENTS.digital_forensics[
          selectedCurrency
        ];

    }

    else {

      expectedPayment =
        EXPECTED_PAYMENTS[track];

    }


    if (!expectedPayment) {

      console.error(
        'Unknown payment track:',
        track
      );

      return res.status(400).json({

        verified: false,

        error:
          'Payment track could not be verified.'

      });

    }


    /* =====================================================
       4. VERIFY CURRENCY
    ===================================================== */

    if (
      transaction.currency !==
      expectedPayment.currency
    ) {

      console.error(
        'Currency mismatch:',
        {
          reference,
          expected:
            expectedPayment.currency,
          received:
            transaction.currency
        }
      );

      return res.status(400).json({

        verified: false,

        error:
          'The payment currency could not be verified.'

      });

    }


    /* =====================================================
       5. VERIFY AMOUNT
    ===================================================== */

    if (
      Number(transaction.amount) !==
      Number(expectedPayment.amount)
    ) {

      console.error(
        'Amount mismatch:',
        {
          reference,
          expected:
            expectedPayment.amount,
          received:
            transaction.amount
        }
      );

      return res.status(400).json({

        verified: false,

        error:
          'The payment amount could not be verified.'

      });

    }


    /* =====================================================
       EVERYTHING MATCHES
    ===================================================== */

    console.log(
      'Payment successfully verified:',
      reference
    );


    return res.status(200).json({

      verified: true,

      reference:
        transaction.reference,

      track,

      currency:
        transaction.currency

    });


  } catch (error) {

    console.error(
      'Payment verification error:',
      error
    );

    return res.status(500).json({

      verified: false,

      error:
        'We could not verify your payment. Please try again.'

    });

  }

};