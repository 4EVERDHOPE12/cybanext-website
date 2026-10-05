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

const conversionNote =
    document.getElementById('conversionNote');

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


applicantNameElement.textContent =
    applicantName || 'Applicant';

applicantEmailElement.textContent =
    applicantEmail || 'Email unavailable';


// --------------------------------------------------
// Currency state
// --------------------------------------------------

let selectedCurrency = 'GHS';


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
// Update visible payment details
// --------------------------------------------------

function updateCurrencyUI() {
    const isGHS = selectedCurrency === 'GHS';

    ghsBtn.classList.toggle('active', isGHS);
    usdBtn.classList.toggle('active', !isGHS);

    totalAmount.textContent =
        isGHS ? 'GH₵1,200' : 'GH₵1,386.00';

    paymentMethods.textContent =
        'Mobile Money (MTN, Telecel, AT) & Cards';

    payNowBtn.innerHTML =
        isGHS
            ? 'Pay GH₵1,200 with Paystack <i class="ti ti-arrow-right"></i>'
            : 'Pay GH₵1,386.00 with Paystack <i class="ti ti-arrow-right"></i>';

    if (conversionNote) {
        conversionNote.innerHTML = isGHS
            ? 'Local price: <strong>GH₵1,200</strong>. Paystack will charge you in GHS.'
            : 'Advertised international price: <strong>$120 USD</strong> &nbsp;•&nbsp; Checkout amount: <strong>GH₵1,386.00</strong><br>Conversion rate used: <strong>GH₵11.55 / $1</strong>. Paystack will charge you in GHS.';
    }
}


// --------------------------------------------------
// Initialize selected currency on the server
// --------------------------------------------------

async function initializePayment() {
    if (!applicantEmail) {
        throw new Error(
            'Applicant email could not be found. Please return to the application page and try again.'
        );
    }

    const response = await fetch(
        '/api/initialize-digital-forensics-payment',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: applicantEmail,
                name: applicantName || '',
                currency: selectedCurrency
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

    const expectedAmount =
        selectedCurrency === 'GHS'
            ? 120000
            : 138600;

    const expectedGhsAmount =
        selectedCurrency === 'GHS'
            ? 1200
            : 1386;

    if (!response.ok || !result.authorizationUrl) {
        throw new Error(
            result.error ||
            'We could not initialize your payment. Please try again.'
        );
    }

    if (
        result.track !== 'digital_forensics' ||
        Number(result.amount) !== expectedAmount ||
        result.currency !== 'GHS' ||
        Number(result.chargeAmountGhs) !== expectedGhsAmount
    ) {
        throw new Error(
            'The selected payment amount could not be confirmed. Please try again.'
        );
    }

    return result;
}


// --------------------------------------------------
// Start hosted Paystack checkout
// --------------------------------------------------

async function startPaystackPayment() {
    if (!applicantEmail) {
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
        `Preparing your ${selectedCurrency} payment...`,
        'info'
    );

    try {
        const payment = await initializePayment();

        showPaymentMessage(
            'Redirecting you to secure Paystack checkout...',
            'success'
        );

        window.location.href = payment.authorizationUrl;

    } catch (error) {
        console.error(
            'Digital Forensics payment initialization error:',
            error
        );

        payNowBtn.disabled = false;

        updateCurrencyUI();

        showPaymentMessage(
            error.message ||
            'We could not prepare your payment. Please try again.',
            'error'
        );
    }
}


// --------------------------------------------------
// Currency buttons
// --------------------------------------------------

ghsBtn.addEventListener('click', () => {
    if (selectedCurrency === 'GHS') return;

    selectedCurrency = 'GHS';
    updateCurrencyUI();
    showPaymentMessage(
        'GHS selected. Paystack will charge GH₵1,200.',
        'info'
    );
});


usdBtn.addEventListener('click', () => {
    if (selectedCurrency === 'USD') return;

    selectedCurrency = 'USD';
    updateCurrencyUI();
    showPaymentMessage(
        'USD reference selected. $120 ≈ GH₵1,386.00 at GH₵11.55/USD. Paystack will charge you in GHS.',
        'info'
    );
});


payNowBtn.addEventListener(
    'click',
    startPaystackPayment
);


// --------------------------------------------------
// Initial UI
// --------------------------------------------------

updateCurrencyUI();
