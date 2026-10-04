const applicantNameElement = document.getElementById('applicantName');
const applicantEmailElement = document.getElementById('applicantEmail');
const ghsBtn = document.getElementById('ghsBtn');
const usdBtn = document.getElementById('usdBtn');
const totalAmount = document.getElementById('totalAmount');
const paymentMethods = document.getElementById('paymentMethods');
const payNowBtn = document.getElementById('payNowBtn');
const paymentMessage = document.getElementById('paymentMessage');

const applicantName = sessionStorage.getItem('applicantName');
const applicantEmail = sessionStorage.getItem('applicantEmail');

let selectedCurrency = 'GHS';
let paymentSession = null;
let paymentReady = false;

applicantNameElement.textContent = applicantName || 'Applicant';
applicantEmailElement.textContent = applicantEmail || 'Email unavailable';

function showPaymentMessage(message, type = 'info') {
    paymentMessage.textContent = message;
    paymentMessage.className = `dfir-payment-message ${type}`;
    paymentMessage.style.display = 'block';
}

function updateCurrencyUI() {
    const isGHS = selectedCurrency === 'GHS';

    ghsBtn.classList.toggle('active', isGHS);
    usdBtn.classList.toggle('active', !isGHS);

    totalAmount.textContent = isGHS ? 'GH₵1,200' : '$120';
    paymentMethods.textContent = isGHS
        ? 'Mobile Money (MTN, Telecel, AT) & Cards'
        : 'Debit / Credit Cards';

    payNowBtn.innerHTML = isGHS
        ? 'Pay GH₵1,200 with Paystack <i class="ti ti-arrow-right"></i>'
        : 'Pay $120 with Paystack <i class="ti ti-arrow-right"></i>';
}

async function initializePayment() {
    if (!applicantEmail) {
        throw new Error(
            'Applicant email could not be found. Please return to the application page and try again.'
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
            track: 'digital_forensics',
            currency: selectedCurrency
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

    const expectedAmount = selectedCurrency === 'GHS' ? 120000 : 12000;

    if (
        Number(result.amount) !== expectedAmount ||
        result.currency !== selectedCurrency ||
        result.track !== 'digital_forensics'
    ) {
        throw new Error(
            'The payment amount could not be confirmed. Please refresh and try again.'
        );
    }

    return result;
}

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
    payNowBtn.innerHTML = '<i class="ti ti-loader-2 dfir-spin"></i> Preparing payment...';
    showPaymentMessage('Preparing your secure payment...', 'info');

    try {
        paymentSession = await initializePayment();
        paymentReady = true;
        payNowBtn.disabled = false;
        updateCurrencyUI();
        showPaymentMessage('Your payment is ready. Click the button to continue.', 'success');
    } catch (error) {
        console.error('Payment preparation error:', error);
        paymentReady = false;
        paymentSession = null;
        payNowBtn.disabled = false;
        updateCurrencyUI();
        showPaymentMessage(
            error.message || 'We could not prepare your payment. Please try again.',
            'error'
        );
    }
}

ghsBtn.addEventListener('click', () => {
    if (selectedCurrency === 'GHS') return;
    selectedCurrency = 'GHS';
    updateCurrencyUI();
    preparePayment();
});

usdBtn.addEventListener('click', () => {
    if (selectedCurrency === 'USD') return;
    selectedCurrency = 'USD';
    updateCurrencyUI();
    preparePayment();
});

function startPaystackPayment() {
    if (!paymentReady || !paymentSession?.authorizationUrl) {
        preparePayment();
        return;
    }

    payNowBtn.disabled = true;
    showPaymentMessage('Opening secure Paystack checkout...', 'info');

    sessionStorage.setItem('pendingPaymentReference', paymentSession.reference);
    sessionStorage.setItem('pendingPaymentTrack', 'digital_forensics');
    sessionStorage.setItem('pendingPaymentCurrency', selectedCurrency);

    window.location.href = paymentSession.authorizationUrl;
}

payNowBtn.addEventListener('click', startPaystackPayment);

updateCurrencyUI();
preparePayment();
