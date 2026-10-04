const applicantNameElement =
    document.getElementById('applicantName');

const applicantEmailElement =
    document.getElementById('applicantEmail');

const ghsBtn =
    document.getElementById('ghsBtn');

const usdBtn =
    document.getElementById('usdBtn');

const ghsAmount =
    document.getElementById('ghsAmount');

const usdAmount =
    document.getElementById('usdAmount');

const payNowBtn =
    document.getElementById('payNowBtn');

const paymentMessage =
    document.getElementById('paymentMessage');


// --------------------------------------------------
// Applicant information
// --------------------------------------------------

const applicantName =
    sessionStorage.getItem('applicantName');

const applicantEmail =
    sessionStorage.getItem('applicantEmail');


// --------------------------------------------------
// Payment state
// --------------------------------------------------

let selectedCurrency = 'GHS';

let paymentSession = null;

let paymentReady = false;


// --------------------------------------------------
// Display applicant information
// --------------------------------------------------

applicantNameElement.textContent =
    applicantName || 'Applicant';

applicantEmailElement.textContent =
    applicantEmail || 'Email unavailable';


// --------------------------------------------------
// Payment message helper
// --------------------------------------------------

function showPaymentMessage(message, type = 'info') {

    paymentMessage.textContent = message;

    paymentMessage.className =
        `dfir-payment-message ${type}`;

    paymentMessage.style.display = 'block';
}


// --------------------------------------------------
// Update currency UI
// --------------------------------------------------

function updateCurrencyUI() {

    const isGHS =
        selectedCurrency === 'GHS';


    ghsBtn.classList.toggle(
        'active',
        isGHS
    );

    usdBtn.classList.toggle(
        'active',
        !isGHS
    );


    ghsAmount.style.display =
        isGHS ? 'block' : 'none';

    usdAmount.style.display =
        isGHS ? 'none' : 'block';


    payNowBtn.innerHTML =
        isGHS
            ? 'Pay GH₵1,200 with Paystack <i class="ti ti-arrow-right"></i>'
            : 'Pay $120 with Paystack <i class="ti ti-arrow-right"></i>';
}


// --------------------------------------------------
// Initialize payment on server
// --------------------------------------------------

async function initializePayment() {

    if (!applicantEmail) {

        throw new Error(
            'Applicant email could not be found. Please return to the application page and try again.'
        );

    }


    const response =
        await fetch(
            '/api/initialize-payment',
            {
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
            }
        );


    let result;

    try {

        result =
            await response.json();

    } catch (error) {

        throw new Error(
            'The payment server returned an unexpected response.'
        );

    }


    if (
        !response.ok ||
        !result.accessCode
    ) {

        throw new Error(
            result.error ||
            'We could not initialize your payment. Please try again.'
        );

    }


    // Confirm the server returned the expected
    // amount and currency for the selected option.

    const expectedAmount =
        selectedCurrency === 'GHS'
            ? 120000
            : 12000;


    if (
        result.amount !== expectedAmount ||
        result.currency !== selectedCurrency
    ) {

        throw new Error(
            'The payment amount could not be confirmed. Please refresh and try again.'
        );

    }


    return result;
}


// --------------------------------------------------
// Prepare payment
// --------------------------------------------------

async function preparePayment() {

    if (!applicantEmail) {

        showPaymentMessage(
            'Your applicant information could not be found. Please return to the application and try again.',
            'error'
        );

        return;
    }


    paymentReady = false;

    paymentSession = null;


    payNowBtn.disabled = true;

    payNowBtn.innerHTML = `
        <i class="ti ti-loader-2 dfir-spin"></i>
        Preparing payment...
    `;


    showPaymentMessage(
        'Preparing your secure payment...',
        'info'
    );


    try {

        paymentSession =
            await initializePayment();


        paymentReady = true;


        payNowBtn.disabled = false;


        payNowBtn.innerHTML =
            selectedCurrency === 'GHS'
                ? 'Pay GH₵1,200 with Paystack <i class="ti ti-arrow-right"></i>'
                : 'Pay $120 with Paystack <i class="ti ti-arrow-right"></i>';


        showPaymentMessage(
            'Your payment is ready. Click the button to continue.',
            'success'
        );


    } catch (error) {

        console.error(
            'Payment preparation error:',
            error
        );


        paymentReady = false;

        paymentSession = null;

        payNowBtn.disabled = false;


        payNowBtn.innerHTML =
            'Try Payment Again <i class="ti ti-refresh"></i>';


        showPaymentMessage(
            error.message ||
            'We could not prepare your payment. Please try again.',
            'error'
        );

    }

}


// --------------------------------------------------
// Currency selection
// --------------------------------------------------

ghsBtn.addEventListener(
    'click',
    function() {

        if (selectedCurrency === 'GHS') {
            return;
        }


        selectedCurrency = 'GHS';

        updateCurrencyUI();

        preparePayment();

    }
);


usdBtn.addEventListener(
    'click',
    function() {

        if (selectedCurrency === 'USD') {
            return;
        }


        selectedCurrency = 'USD';

        updateCurrencyUI();

        preparePayment();

    }
);


// --------------------------------------------------
// Start Paystack payment
// --------------------------------------------------

function startPaystackPayment() {

    if (
        !paymentReady ||
        !paymentSession
    ) {

        showPaymentMessage(
            'Your payment is still being prepared. Please wait a moment and try again.',
            'info'
        );

        preparePayment();

        return;

    }


    if (
        typeof PaystackPop === 'undefined'
    ) {

        showPaymentMessage(
            'Payment service could not be loaded. Please refresh the page and try again.',
            'error'
        );

        return;

    }


    /*
      IMPORTANT:

      resumeTransaction() happens directly from
      the user's click. There is no await before it.

      This helps prevent the browser from treating
      Paystack as an unsolicited popup.
    */

    payNowBtn.disabled = true;


    showPaymentMessage(
        'Opening secure Paystack checkout...',
        'info'
    );


    const popup =
        new PaystackPop();


    popup.resumeTransaction(
        paymentSession.accessCode,
        {

            onSuccess:
                function(transaction) {

                    showPaymentMessage(
                        'Payment received. Verifying your transaction...',
                        'info'
                    );


                    verifyPaymentOnServer(
                        transaction.reference
                    );

                },


            onCancel:
                function() {

                    payNowBtn.disabled =
                        false;


                    showPaymentMessage(
                        'Payment was cancelled. You can try again when you are ready.',
                        'error'
                    );

                },


            onError:
                function(error) {

                    console.error(
                        'Paystack error:',
                        error
                    );


                    payNowBtn.disabled =
                        false;


                    showPaymentMessage(
                        'Paystack could not complete the payment. Please try again.',
                        'error'
                    );

                }

        }
    );

}


// --------------------------------------------------
// Server-side payment verification
// --------------------------------------------------

async function verifyPaymentOnServer(
    reference
) {

    if (!reference) {

        payNowBtn.disabled =
            false;


        showPaymentMessage(
            'No payment reference was received. Please try again.',
            'error'
        );

        return;

    }


    try {

        const response =
            await fetch(
                '/api/verify-payment',
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body: JSON.stringify({
                        reference
                    })

                }
            );


        let result;

        try {

            result =
                await response.json();

        } catch (error) {

            throw new Error(
                'Invalid verification response.'
            );

        }


        if (
            !response.ok ||
            !result.verified
        ) {

            throw new Error(
                result.error ||
                'Your payment could not be verified.'
            );

        }


        /*
          Only redirect after server verification.
        */

        window.location.href =
            './success.html?reference=' +
            encodeURIComponent(reference);

    } catch (error) {

        console.error(
            'Payment verification error:',
            error
        );


        payNowBtn.disabled =
            false;


        showPaymentMessage(
            error.message ||
            'We could not verify your payment. Please contact Cybanext support.',
            'error'
        );

    }

}


// --------------------------------------------------
// Pay button
// --------------------------------------------------

payNowBtn.addEventListener(
    'click',
    startPaystackPayment
);


// --------------------------------------------------
// Initial UI + payment preparation
// --------------------------------------------------

updateCurrencyUI();

preparePayment();