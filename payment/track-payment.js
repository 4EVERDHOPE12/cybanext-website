const applicantNameElement =
    document.getElementById('applicantName');

const applicantEmailElement =
    document.getElementById('applicantEmail');

const selectedTrackElement =
    document.getElementById('selectedTrack');

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

const selectedTrack =
    sessionStorage.getItem('selectedTrack');

const applicantTrackLabel =
    sessionStorage.getItem('applicantTrackLabel');


// --------------------------------------------------
// Guard against wrong payment page
// --------------------------------------------------

if (
    selectedTrack?.trim().toLowerCase().replace(/[\s-]+/g, '_') ===
    'digital_forensics'
) {
    window.location.replace('./digital-forensics.html');
}


// --------------------------------------------------
// Display applicant information
// --------------------------------------------------

applicantNameElement.textContent =
    applicantName || 'Applicant';

applicantEmailElement.textContent =
    applicantEmail || 'Email unavailable';

selectedTrackElement.textContent =
    applicantTrackLabel || 'Selected Track';


// --------------------------------------------------
// Payment state
// --------------------------------------------------

let paymentSession = null;

let paymentReady = false;


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
// Initialize payment on server
// --------------------------------------------------

async function initializePayment() {

    if (!applicantEmail) {
        throw new Error(
            'Applicant email could not be found. Please return to the application page and try again.'
        );
    }

    if (!selectedTrack) {
        throw new Error(
            'Your selected track could not be found. Please return to the application page and try again.'
        );
    }


    const response = await fetch(
        '/api/initialize-payment',
        {
            method: 'POST',

            headers: {
                'Content-Type': 'application/json'
            },

            body: JSON.stringify({
                email: applicantEmail,
                name: applicantName || '',
                track: selectedTrack
            })
        }
    );


    let result;

    try {
        result = await response.json();
    } catch (error) {
        throw new Error(
            'The payment server returned an unexpected response.'
        );
    }


    if (!response.ok || !result.accessCode) {
        throw new Error(
            result.error ||
            'We could not initialize your payment. Please try again.'
        );
    }


    // Confirm the server selected the correct regular-track price.
    if (
        result.track !== selectedTrack ||
        result.amount !== 3000 ||
        result.currency !== 'USD'
    ) {
        throw new Error(
            'The payment amount could not be confirmed. Please refresh and try again.'
        );
    }


    return result;
}


// --------------------------------------------------
// Prepare payment before user clicks
// --------------------------------------------------

async function preparePayment() {

    if (!applicantEmail || !selectedTrack) {
        showPaymentMessage(
            'Your applicant information could not be found. Please return to the application and try again.',
            'error'
        );

        return;
    }


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
            'Pay $30 with Paystack <i class="ti ti-arrow-right"></i>';


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
// Open Paystack
// --------------------------------------------------

function startPaystackPayment() {

    if (!paymentReady || !paymentSession) {

        showPaymentMessage(
            'Your payment is still being prepared. Please wait a moment and try again.',
            'info'
        );

        preparePayment();

        return;
    }


    if (typeof PaystackPop === 'undefined') {

        showPaymentMessage(
            'Payment service could not be loaded. Please refresh the page and try again.',
            'error'
        );

        return;
    }


    /*
      IMPORTANT:

      There is no await before resumeTransaction().

      The user click directly triggers Paystack,
      which prevents the browser from treating
      the checkout as an unsolicited popup.
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

            onSuccess: function(transaction) {

                showPaymentMessage(
                    'Payment received. Verifying your transaction...',
                    'info'
                );


                verifyPaymentOnServer(
                    transaction.reference
                );
            },


            onCancel: function() {

                payNowBtn.disabled = false;

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


                payNowBtn.disabled = false;


                showPaymentMessage(
                    'Paystack could not complete the payment. Please try again.',
                    'error'
                );
            }

        }
    );
}


// --------------------------------------------------
// Server-side verification
// --------------------------------------------------

async function verifyPaymentOnServer(reference) {

    if (!reference) {

        payNowBtn.disabled = false;

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
            result = await response.json();
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


        payNowBtn.disabled = false;


        showPaymentMessage(
            error.message ||
            'We could not verify your payment. Please contact Cybanext support.',
            'error'
        );
    }
}


// --------------------------------------------------
// Payment button
// --------------------------------------------------

payNowBtn.addEventListener(
    'click',
    startPaystackPayment
);


// --------------------------------------------------
// Prepare payment immediately when page loads
// --------------------------------------------------

preparePayment();