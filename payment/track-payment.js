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
// Payment message helper
// --------------------------------------------------

function showPaymentMessage(message, type = 'info') {
    paymentMessage.textContent = message;
    paymentMessage.className =
        `dfir-payment-message ${type}`;
    paymentMessage.style.display = 'block';
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

    if (!response.ok || !result.authorizationUrl) {
        throw new Error(
            result.error ||
            'We could not initialize your payment. Please try again.'
        );
    }

    if (
        result.track !== selectedTrack ||
        Number(result.amount) !== 34650 ||
        result.currency !== 'GHS' ||
        Number(result.referenceAmount) !== 30 ||
        result.referenceCurrency !== 'USD' ||
        Number(result.chargeAmountGhs) !== 346.5
    ) {
        throw new Error(
            'The payment amount could not be confirmed. Please refresh and try again.'
        );
    }

    return result;
}


// --------------------------------------------------
// Start Paystack hosted checkout
// --------------------------------------------------

async function startPaystackPayment() {
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
        Opening Paystack...
    `;

    showPaymentMessage(
        'Preparing your secure payment...',
        'info'
    );

    try {
        const payment = await initializePayment();

        showPaymentMessage(
            'Redirecting you to secure Paystack checkout...',
            'success'
        );

        // Hosted checkout avoids popup-blocking and is the redirect flow
        // required for this payment stage.
        window.location.href = payment.authorizationUrl;

    } catch (error) {
        console.error(
            'Payment initialization error:',
            error
        );

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


payNowBtn.addEventListener(
    'click',
    startPaystackPayment
);
