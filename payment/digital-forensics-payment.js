const applicantNameElement = document.getElementById('applicantName');
const applicantEmailElement = document.getElementById('applicantEmail');
const applicantPhoneElement = document.getElementById('applicantPhone');
const ghsBtn = document.getElementById('ghsBtn');
const usdBtn = document.getElementById('usdBtn');
const programPrice = document.getElementById('programPrice');
const totalAmount = document.getElementById('totalAmount');
const paymentMethods = document.getElementById('paymentMethods');
const conversionNote = document.getElementById('conversionNote');
const payNowBtn = document.getElementById('payNowBtn');
const paymentMessage = document.getElementById('paymentMessage');

const registrationId = sessionStorage.getItem('digitalForensicsRegistrationId');
const applicantName = sessionStorage.getItem('digitalForensicsApplicantName');
const applicantEmail = sessionStorage.getItem('digitalForensicsApplicantEmail');
const applicantPhone = sessionStorage.getItem('digitalForensicsApplicantPhone');

applicantNameElement.textContent = applicantName || 'Applicant';
applicantEmailElement.textContent = applicantEmail || 'Email unavailable';
applicantPhoneElement.textContent = applicantPhone || 'Not provided';

if (!registrationId || !applicantEmail) {
    window.location.replace('../index.html');
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

function formatUsd(amount) {
    return `$${Number(amount).toFixed(2)}`;
}

function updateCurrencyUI() {
    const isGHS = selectedCurrency === 'GHS';
    const price = getSelectedPrice();
    const chargeAmount = formatGhs(price.chargeAmountGhs, !isGHS);
    const displayedProgramPrice = isGHS
        ? formatGhs(price.referenceAmount)
        : formatUsd(price.referenceAmount);

    ghsBtn.classList.toggle('active', isGHS);
    usdBtn.classList.toggle('active', !isGHS);
    programPrice.textContent = displayedProgramPrice;
    totalAmount.textContent = chargeAmount;
    paymentMethods.textContent = 'Mobile Money (MTN, Telecel, AT) & Cards';
    payNowBtn.innerHTML =
        `Pay ${displayedProgramPrice} with Paystack <i class="ti ti-arrow-right"></i>`;

    conversionNote.textContent = '';
    conversionNote.hidden = true;
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
    if (!registrationId || !applicantEmail) {
        throw new Error(
            'Your Digital Forensics registration could not be found. Please return and complete the registration form again.'
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
            registrationId,
            pricingOption
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
        result.registrationId !== registrationId ||
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
    if (!registrationId || !applicantEmail || !digitalForensicsPrices) {
        showPaymentMessage(
            'Your registration or current prices could not be found. Please return and complete the registration form again.',
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
});

usdBtn.addEventListener('click', () => {
    if (selectedCurrency === 'USD') return;

    selectedCurrency = 'USD';
    sessionStorage.setItem('selectedPricingOption', 'USD_REFERENCE');
    updateCurrencyUI();
});

payNowBtn.addEventListener('click', startPaystackPayment);
loadPaymentPrices();
