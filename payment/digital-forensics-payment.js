const applicantNameElement = document.getElementById('applicantName');
const applicantEmailElement = document.getElementById('applicantEmail');
const applicantPhoneElement = document.getElementById('applicantPhone');
const ghsBtn = document.getElementById('ghsBtn');
const usdBtn = document.getElementById('usdBtn');
const totalAmount = document.getElementById('totalAmount');
const paymentMethods = document.getElementById('paymentMethods');
const conversionNote = document.getElementById('conversionNote');
const payNowBtn = document.getElementById('payNowBtn');
const paymentMessage = document.getElementById('paymentMessage');

const applicantName = sessionStorage.getItem('applicantName');
const applicantEmail = sessionStorage.getItem('applicantEmail');
const applicantPhone = sessionStorage.getItem('applicantPhone');
const qualificationToken = sessionStorage.getItem('qualificationToken');
const selectedTrack = sessionStorage.getItem('selectedTrack');

applicantNameElement.textContent = applicantName || 'Applicant';
applicantEmailElement.textContent = applicantEmail || 'Email unavailable';
applicantPhoneElement.textContent = applicantPhone || 'Not provided';

if (!qualificationToken || selectedTrack !== 'digital_forensics') {
    window.location.replace('../index.html#applicationForm');
}

let selectedCurrency =
    sessionStorage.getItem('selectedPricingOption') === 'USD_REFERENCE'
        ? 'USD'
        : 'GHS';
let digitalForensicsPrices = null;

function showPaymentMessage(message, type = 'info') {
    paymentMessage.textContent = message;
    paymentMessage.className = `dfir-payment-message ${type}`;
    paymentMessage.style.display = 'block';
}

function getSelectedPrice() {
    if (!digitalForensicsPrices) {
        throw new Error('Current payment prices are not available.');
    }

    return selectedCurrency === 'GHS'
        ? digitalForensicsPrices.GHS
        : digitalForensicsPrices.USD_REFERENCE;
}

function formatGhs(amount, showCents = false) {
    return `GH₵${Number(amount).toLocaleString('en-GH', {
        minimumFractionDigits: showCents ? 2 : 0,
        maximumFractionDigits: 2
    })}`;
}

function updateCurrencyUI() {
    const isGHS = selectedCurrency === 'GHS';
    const price = getSelectedPrice();
    const chargeAmount = formatGhs(price.chargeAmountGhs, !isGHS);

    ghsBtn.classList.toggle('active', isGHS);
    usdBtn.classList.toggle('active', !isGHS);
    totalAmount.textContent = chargeAmount;
    paymentMethods.textContent = 'Mobile Money (MTN, Telecel, AT) & Cards';
    payNowBtn.innerHTML =
        `Pay ${chargeAmount} with Paystack <i class="ti ti-arrow-right"></i>`;

    conversionNote.textContent = isGHS
        ? `Local price: ${chargeAmount}. Paystack will charge you in ${price.paystackCurrency}.`
        : `International reference price: $${price.referenceAmount} ${price.referenceCurrency}. Paystack checkout: ${chargeAmount}. Conversion rate: GH₵${price.exchangeRate} per USD. Paystack will charge you in ${price.paystackCurrency}.`;
}

async function loadPaymentPrices() {
    try {
        const response = await fetch('/api/payment-prices');
        const result = await response.json();

        if (
            !response.ok ||
            !result.digitalForensics?.GHS ||
            !result.digitalForensics?.USD_REFERENCE
        ) {
            throw new Error(
                result.error || 'Current payment prices could not be loaded.'
            );
        }

        digitalForensicsPrices = result.digitalForensics;
        updateCurrencyUI();
        ghsBtn.disabled = false;
        usdBtn.disabled = false;
        payNowBtn.disabled = false;
    } catch (error) {
        console.error('Could not load Digital Forensics prices:', error);
        showPaymentMessage(
            error.message || 'Current payment prices could not be loaded.',
            'error'
        );
    }
}

async function initializePayment() {
    if (!applicantEmail || !qualificationToken) {
        throw new Error(
            'Your qualified application could not be found. Please return to the application page and complete CV screening.'
        );
    }

    const pricingOption =
        selectedCurrency === 'GHS' ? 'GHS' : 'USD_REFERENCE';
    const expectedPrice = getSelectedPrice();
    const response = await fetch('/api/initialize-digital-forensics-payment', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            email: applicantEmail,
            track: selectedTrack,
            pricingOption,
            qualificationToken
        })
    });

    let result;
    try {
        result = await response.json();
    } catch (error) {
        throw new Error('The payment server returned an unexpected response.');
    }

    if (!response.ok || !result.authorizationUrl) {
        throw new Error(
            result.error || 'We could not initialize your payment. Please try again.'
        );
    }

    if (
        result.track !== 'digital_forensics' ||
        result.currency !== expectedPrice.paystackCurrency ||
        Number(result.chargeAmountGhs) !== expectedPrice.chargeAmountGhs ||
        result.pricingOption !== pricingOption ||
        Number(result.referenceAmount) !== expectedPrice.referenceAmount ||
        result.referenceCurrency !== expectedPrice.referenceCurrency
    ) {
        throw new Error(
            'The selected payment amount could not be confirmed. Please try again.'
        );
    }

    return result;
}

async function startPaystackPayment() {
    if (!applicantEmail || !qualificationToken || !digitalForensicsPrices) {
        showPaymentMessage(
            'Your qualified application or current prices could not be found. Please return to the application page and try again.',
            'error'
        );
        return;
    }

    payNowBtn.disabled = true;
    payNowBtn.innerHTML = '<i class="ti ti-loader-2 dfir-spin"></i> Opening Paystack...';
    showPaymentMessage(`Preparing your ${selectedCurrency} payment...`, 'info');

    try {
        const payment = await initializePayment();
        showPaymentMessage(
            'Redirecting you to secure Paystack checkout...',
            'success'
        );
        window.location.href = payment.authorizationUrl;
    } catch (error) {
        console.error('Digital Forensics payment initialization error:', error);
        updateCurrencyUI();
        payNowBtn.disabled = false;
        showPaymentMessage(
            error.message || 'We could not prepare your payment. Please try again.',
            'error'
        );
    }
}

ghsBtn.addEventListener('click', () => {
    if (selectedCurrency === 'GHS') return;

    selectedCurrency = 'GHS';
    sessionStorage.setItem('selectedPricingOption', 'GHS');
    updateCurrencyUI();
    showPaymentMessage(
        `GHS selected. Paystack will charge ${formatGhs(getSelectedPrice().chargeAmountGhs)}.`,
        'info'
    );
});

usdBtn.addEventListener('click', () => {
    if (selectedCurrency === 'USD') return;

    selectedCurrency = 'USD';
    sessionStorage.setItem('selectedPricingOption', 'USD_REFERENCE');
    updateCurrencyUI();
    const price = getSelectedPrice();
    showPaymentMessage(
        `USD reference selected. $${price.referenceAmount} ≈ ${formatGhs(price.chargeAmountGhs, true)} at GH₵${price.exchangeRate}/USD. Paystack will charge you in GHS.`,
        'info'
    );
});

payNowBtn.addEventListener('click', startPaystackPayment);
loadPaymentPrices();
