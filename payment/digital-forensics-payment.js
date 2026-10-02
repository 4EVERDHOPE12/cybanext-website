const PAYSTACK_PUBLIC_KEY =
  'pk_test_ca734c2d47eb80afde47c1814703cd9e0f3d0a30';


/* =========================================================
   ELEMENTS
========================================================= */

const applicantNameElement =
  document.getElementById('applicantName');

const applicantEmailElement =
  document.getElementById('applicantEmail');

const ghsBtn =
  document.getElementById('ghsBtn');

const usdBtn =
  document.getElementById('usdBtn');

const totalAmount =
  document.getElementById('totalAmount');

const paymentMethods =
  document.getElementById('paymentMethods');

const payNowBtn =
  document.getElementById('payNowBtn');

const paymentMessage =
  document.getElementById('paymentMessage');


/* =========================================================
   APPLICANT INFORMATION
========================================================= */

const applicantName =
  sessionStorage.getItem('applicantName');

const applicantEmail =
  sessionStorage.getItem('applicantEmail');


applicantNameElement.textContent =
  applicantName || 'Applicant';

applicantEmailElement.textContent =
  applicantEmail || 'Email unavailable';


/* =========================================================
   CURRENCY STATE
========================================================= */

let selectedCurrency = 'GHS';


/* =========================================================
   PAYMENT MESSAGE
========================================================= */

function showPaymentMessage(message, type = 'info') {

  paymentMessage.textContent = message;

  paymentMessage.className =
    `dfir-payment-message ${type}`;

  paymentMessage.style.display = 'block';

}


/* =========================================================
   UPDATE PAYMENT UI
========================================================= */

function updateCurrencyUI() {

  if (selectedCurrency === 'GHS') {

    totalAmount.textContent =
      'GH₵1,200';

    paymentMethods.textContent =
      'Mobile Money (MTN, Telecel, AT) & Cards';

    payNowBtn.innerHTML = `
      Pay GH₵1,200 with Paystack
      <i class="ti ti-arrow-right"></i>
    `;

    ghsBtn.classList.add('active');

    usdBtn.classList.remove('active');

  }

  else {

    totalAmount.textContent =
      '$120';

    paymentMethods.textContent =
      'International Visa / Mastercard';

    payNowBtn.innerHTML = `
      Pay $120 with Paystack
      <i class="ti ti-arrow-right"></i>
    `;

    usdBtn.classList.add('active');

    ghsBtn.classList.remove('active');

  }

}


/* =========================================================
   CURRENCY BUTTONS
========================================================= */

ghsBtn.addEventListener('click', () => {

  if (payNowBtn.disabled) {
    return;
  }

  selectedCurrency = 'GHS';

  updateCurrencyUI();

});


usdBtn.addEventListener('click', () => {

  if (payNowBtn.disabled) {
    return;
  }

  selectedCurrency = 'USD';

  updateCurrencyUI();

});


/* =========================================================
   INITIALIZE PAYMENT ON SERVER
========================================================= */

async function initializePayment() {

  if (!applicantEmail) {

    throw new Error(
      'Your applicant information could not be found. Please return to the application and try again.'
    );

  }


  const response =
    await fetch('/api/initialize-payment', {

      method: 'POST',

      headers: {
        'Content-Type':
          'application/json'
      },

      body: JSON.stringify({

        email:
          applicantEmail,

        name:
          applicantName || '',

        track:
          'digital_forensics',

        currency:
          selectedCurrency

      })

    });


  let result;

  try {

    result =
      await response.json();

  } catch (error) {

    throw new Error(
      'The payment server returned an unexpected response.'
    );

  }


  if (!response.ok) {

    throw new Error(
      result.error ||
      'We could not initialize your payment.'
    );

  }


  if (!result.accessCode) {

    throw new Error(
      'Paystack did not return a valid payment session.'
    );

  }


  return result;

}


/* =========================================================
   OPEN PAYSTACK
========================================================= */

async function startPaystackPayment() {

  if (!applicantEmail) {

    showPaymentMessage(
      'Your applicant information could not be found. Please return to the application and try again.',
      'error'
    );

    return;

  }


  payNowBtn.disabled = true;

  ghsBtn.disabled = true;

  usdBtn.disabled = true;


  payNowBtn.innerHTML = `
    <i class="ti ti-loader-2 dfir-spin"></i>
    Initializing payment...
  `;


  showPaymentMessage(
    'Connecting securely to Paystack...',
    'info'
  );


  try {

    const payment =
      await initializePayment();


    /*
      Paystack InlineJS v2

      The backend has already determined:
      - amount
      - currency
      - payment reference

      The browser only receives the access code.
    */

    const popup =
      new PaystackPop();


    popup.resumeTransaction(
      payment.accessCode,

      {

        onSuccess: function(transaction) {

          /*
            Do NOT treat this callback alone
            as proof of payment.

            The transaction must be verified
            server-side.
          */

          showPaymentMessage(
            'Payment received. Verifying your transaction...',
            'info'
          );


          verifyPaymentOnServer(
            transaction.reference
          );

        },


        onCancel: function() {

          resetPaymentButton();

          showPaymentMessage(
            'Payment was cancelled. You can try again when you are ready.',
            'error'
          );

        },


        onError: function(error) {

          console.error(
            'Paystack error:',
            error
          );

          resetPaymentButton();

          showPaymentMessage(
            'Paystack could not complete the payment. Please try again.',
            'error'
          );

        }

      }

    );


  } catch (error) {

    console.error(
      'Payment initialization error:',
      error
    );

    resetPaymentButton();

    showPaymentMessage(
      error.message ||
      'We could not start your payment. Please try again.',
      'error'
    );

  }

}


/* =========================================================
   SERVER-SIDE PAYMENT VERIFICATION
========================================================= */

async function verifyPaymentOnServer(reference) {

  try {

    const response =
      await fetch('/api/verify-payment', {

        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({

          reference

        })

      });


    let result;

    try {

      result =
        await response.json();

    } catch (error) {

      throw new Error(
        'Invalid verification response.'
      );

    }


    if (!response.ok || !result.verified) {

      throw new Error(
        result.error ||
        'Your payment could not be verified.'
      );

    }


    /*
      Only redirect after the server confirms
      the payment.
    */

    window.location.href =
      './success.html?reference=' +
      encodeURIComponent(reference);


  } catch (error) {

    console.error(
      'Payment verification error:',
      error
    );

    resetPaymentButton();

    showPaymentMessage(
      error.message ||
      'We could not verify your payment. Please contact Cybanext support.',
      'error'
    );

  }

}


/* =========================================================
   RESET PAYMENT BUTTON
========================================================= */

function resetPaymentButton() {

  payNowBtn.disabled = false;

  ghsBtn.disabled = false;

  usdBtn.disabled = false;

  updateCurrencyUI();

}


/* =========================================================
   PAY BUTTON
========================================================= */

payNowBtn.addEventListener(
  'click',
  startPaystackPayment
);


/* =========================================================
   INITIAL UI
========================================================= */

updateCurrencyUI();