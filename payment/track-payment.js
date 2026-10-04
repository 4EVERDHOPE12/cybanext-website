const applicantNameElement = document.getElementById('applicantName');
const applicantEmailElement = document.getElementById('applicantEmail');
const selectedTrackElement = document.getElementById('selectedTrack');
const payNowBtn = document.getElementById('payNowBtn');
const paymentMessage = document.getElementById('paymentMessage');

const applicantName = sessionStorage.getItem('applicantName');
const applicantEmail = sessionStorage.getItem('applicantEmail');
const selectedTrack = sessionStorage.getItem('selectedTrack');
const applicantTrackLabel = sessionStorage.getItem('applicantTrackLabel');

if (
    selectedTrack?.trim().toLowerCase().replace(/[\s-]+/g, '_') ===
    'digital_forensics'
) {
    window.location.replace('./digital-forensics.html');
}

applicantNameElement.textContent = applicantName || 'Applicant';
applicantEmailElement.textContent = applicantEmail || 'Email unavailable';
selectedTrackElement.textContent = applicantTrackLabel || 'Selected Track';

let paymentSession = null;
let paymentReady = false;

function showPaymentMessage(message, type = 'info') {
    paymentMessage.textContent = message;
    paymentMessage.className = `dfir-payment-message ${type}`;
    paymentMessage.style.display = 'block';
}

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

    let result;

    try {
        result = await response.json();
    } catch (error) {
        throw new Error('The payment server returned an unexpected response.');
    }

    if (!response.ok || !result.accessCode || !result.authorizationUrl) {
        throw new Error(
            result.error ||
            'We could not initialize your payment. Please try again.'
        );
    }

    if (
        result.track !== selectedTrack ||
        Number(result.amount) !== 3000 ||
        result.currency !== 'USD'
    ) {
        throw new Error(
            'The payment amount could not be confirmed. Please refresh and try again.'
        );
    }

    return result;
}

async function preparePayment() {
    if (!applicantEmail || !selectedTrack) {
        showPaymentMessage(
            'Your applicant information could not be found. Please return to the application and try again.',
            'error'
        );
        return;
    }

    paymentReady = false;
    paymentSession = null;
    payNowBtn.disabled = true;
    payNowBtn.innerHTML = '<i class="ti ti-loader-2 dfir-spin"></i> Preparing payment...';

    showPaymentMessage('Preparing your secure payment...', 'info');

    try {
        paymentSession = await initializePayment();
        paymentReady = true;
        payNowBtn.disabled = false;
        payNowBtn.innerHTML = 'Pay $30 with Paystack <i class="ti ti-arrow-right"></i>';
        showPaymentMessage('Your payment is ready. Click the button to continue.', 'success');
    } catch (error) {
        console.error('Payment preparation error:', error);
        paymentReady = false;
        paymentSession = null;
        payNowBtn.disabled = false;
        payNowBtn.innerHTML = 'Try Payment Again <i class="ti ti-refresh"></i>';
        showPaymentMessage(
            error.message || 'We could not prepare your payment. Please try again.',
            'error'
        );
    }
}

function startPaystackPayment() {
    if (!paymentReady || !paymentSession?.authorizationUrl) {
        preparePayment();
        return;
    }

    payNowBtn.disabled = true;
    showPaymentMessage('Opening secure Paystack checkout...', 'info');

    sessionStorage.setItem('pendingPaymentReference', paymentSession.reference);
    sessionStorage.setItem('pendingPaymentTrack', selectedTrack);

    // Hosted checkout is the most reliable completion method for a server-created
    // transaction and keeps the secret key entirely on the server.
    window.location.href = paymentSession.authorizationUrl;
}

payNowBtn.addEventListener('click', startPaystackPayment);
preparePayment();
