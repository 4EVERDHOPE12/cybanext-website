const applicantNameElement = document.getElementById('applicantName');
const applicantEmailElement = document.getElementById('applicantEmail');
const selectedTrackElement = document.getElementById('selectedTrack');
const payNowBtn = document.getElementById('payNowBtn');
const paymentMessage = document.getElementById('paymentMessage');


// --------------------------------------------------
// Get applicant information
// --------------------------------------------------

const applicantName = sessionStorage.getItem('applicantName');
const applicantEmail = sessionStorage.getItem('applicantEmail');
const selectedTrack = sessionStorage.getItem('selectedTrack');
const applicantTrackLabel = sessionStorage.getItem('applicantTrackLabel');


// --------------------------------------------------
// Display applicant information
// --------------------------------------------------

applicantNameElement.textContent = applicantName || 'Applicant';

applicantEmailElement.textContent =
    applicantEmail || 'Email unavailable';

selectedTrackElement.textContent =
    applicantTrackLabel || 'Selected Track';


// --------------------------------------------------
// Payment message helper
// --------------------------------------------------

function showPaymentMessage(message, type = 'info') {

    paymentMessage.textContent = message;

    paymentMessage.className =
        `dfir-payment-message ${type}`;

}


// --------------------------------------------------
// Initialize payment on the server
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


    const response = await fetch('/api/initialize-payment', {

        method: 'POST',

        headers: {
            'Content-Type': 'application/json'
        },

        body: JSON.stringify({

            email: applicantEmail,

            name: applicantName || '',

            track: selectedTrack

        })

    });


    const result = await response.json();


    if (!response.ok || !result.accessCode) {

        throw new Error(
            result.error ||
            'We could not initialize your payment. Please try again.'
        );

    }


    return result;

}


// --------------------------------------------------
// Start Paystack payment
// --------------------------------------------------

async function startPaystackPayment() {

    if (payNowBtn.disabled) {
        return;
    }


    if (typeof PaystackPop === 'undefined') {

        showPaymentMessage(
            'Payment service could not be loaded. Please refresh the page and try again.',
            'error'
        );

        return;
    }


    payNowBtn.disabled = true;

    payNowBtn.innerHTML =
        'Initializing payment...';


    showPaymentMessage(
        'Preparing your secure payment...',
        'info'
    );


    try {

        // Initialize transaction through our server
        const payment = await initializePayment();


        showPaymentMessage(
            'Opening secure Paystack checkout...',
            'info'
        );


        // Open Paystack using the server-generated access code
        const popup = new PaystackPop();


        popup.resumeTransaction(
            payment.accessCode,
            {

                onSuccess: function (transaction) {

                    // Never trust the browser callback alone.
                    // The transaction must be verified by our server.
                    verifyPaymentOnServer(
                        transaction.reference
                    );

                },


                onCancel: function () {

                    showPaymentMessage(
                        'Payment was cancelled. You can try again when you are ready.',
                        'info'
                    );

                    resetPaymentButton();

                },


                onError: function () {

                    showPaymentMessage(
                        'The payment could not be completed. Please try again.',
                        'error'
                    );

                    resetPaymentButton();

                }

            }
        );


    } catch (error) {

        console.error(
            'Payment initialization error:',
            error
        );


        showPaymentMessage(
            error.message ||
            'Something went wrong while preparing your payment.',
            'error'
        );


        resetPaymentButton();

    }

}


// --------------------------------------------------
// Verify payment through our server
// --------------------------------------------------

async function verifyPaymentOnServer(reference) {

    if (!reference) {

        showPaymentMessage(
            'No payment reference was received. Please try again.',
            'error'
        );

        resetPaymentButton();

        return;
    }


    showPaymentMessage(
        'Verifying your payment...',
        'info'
    );


    payNowBtn.disabled = true;


    try {

        const response = await fetch(
            '/api/verify-payment',
            {

                method: 'POST',

                headers: {
                    'Content-Type': 'application/json'
                },

                body: JSON.stringify({
                    reference
                })

            }
        );


        const result = await response.json();


        if (!response.ok || !result.verified) {

            throw new Error(
                result.error ||
                'Payment verification failed.'
            );

        }


        // Only redirect after server verification succeeds
        window.location.href =
            './success.html?reference=' +
            encodeURIComponent(reference);


    } catch (error) {

        console.error(
            'Payment verification error:',
            error
        );


        showPaymentMessage(
            error.message ||
            'We could not verify your payment. Please contact Cybanext support.',
            'error'
        );


        resetPaymentButton();

    }

}


// --------------------------------------------------
// Reset payment button
// --------------------------------------------------

function resetPaymentButton() {

    payNowBtn.disabled = false;

    payNowBtn.innerHTML =
        'Pay $30 with Paystack <i class="ti ti-arrow-right"></i>';

}


// --------------------------------------------------
// Start payment
// --------------------------------------------------

payNowBtn.addEventListener(
    'click',
    startPaystackPayment
);