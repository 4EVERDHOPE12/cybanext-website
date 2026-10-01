const PAYSTACK_PUBLIC_KEY = 'pk_test_ca734c2d47eb80afde47c1814703cd9e0f3d0a30';


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

  } else {

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

  selectedCurrency = 'GHS';

  updateCurrencyUI();

});


usdBtn.addEventListener('click', () => {

  selectedCurrency = 'USD';

  updateCurrencyUI();

});


/* =========================================================
   PAYMENT REFERENCE
========================================================= */

function generatePaymentReference() {

  const timestamp = Date.now();

  const randomPart =
    Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();

  return `DFIR_${timestamp}_${randomPart}`;
}


/* =========================================================
   PAYSTACK CHECKOUT
========================================================= */

function startPaystackPayment() {

  if (!applicantEmail) {

    paymentMessage.textContent =
      'Your applicant information could not be found. Please return to the application and try again.';

    paymentMessage.style.display = 'block';

    return;
  }


  payNowBtn.disabled = true;

  payNowBtn.innerHTML =
    'Initializing Paystack...';


  const reference =
    generatePaymentReference();


  const amount =
    selectedCurrency === 'GHS'
      ? 120000
      : 12000;


  const currency =
    selectedCurrency;


  const handler =
    PaystackPop.setup({

      key: PAYSTACK_PUBLIC_KEY,

      email: applicantEmail,

      amount: amount,

      currency: currency,

      ref: reference,

      channels:
        selectedCurrency === 'GHS'
          ? ['card', 'mobile_money']
          : ['card'],

      callback: function(response) {

        console.log(
          'Paystack payment completed:',
          response.reference
        );

        verifyPaymentOnServer(
          response.reference
        );

      },

      onClose: function() {

        payNowBtn.disabled = false;

        updateCurrencyUI();

        paymentMessage.textContent =
          'Payment window closed. You can try again when you are ready.';

        paymentMessage.style.display =
          'block';

      }

    });


  handler.openIframe();

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