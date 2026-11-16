const applicantNameElement = document.getElementById('applicantName');
const applicantEmailElement = document.getElementById('applicantEmail');
const applicantPhoneElement = document.getElementById('applicantPhone');
const ghsBtn = document.getElementById('ghsBtn');
const usdBtn = document.getElementById('usdBtn');
const programPriceLabel = document.getElementById('programPriceLabel');
const programPrice = document.getElementById('programPrice');
const totalAmountLabel = document.getElementById('totalAmountLabel');
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
let registrationPriceQuote = null;
let quoteRequestId = 0;

function showPaymentMessage(message, type = 'info') {
    paymentMessage.textContent = message;
    paymentMessage.className = `dfir-payment-message ${type}`;
    paymentMessage.style.display = 'block';
}

function formatGhs(amount, showCents = false) {
    return `GH₵${Number(amount).toLocaleString('en-GH', {
        minimumFractionDigits: showCents ? 2 : 0,
        maximumFractionDigits: 2
    })}`;
}

function formatUsd(amount) {
    return `US$${Number(amount).toFixed(2)}`;
}

function validQuote(quote) {
    const referenceAmount = Number(quote && quote.referenceAmount);
    const chargeAmountGhs = Number(quote && quote.chargeAmountGhs);
    const paystackAmount = Number(quote && quote.paystackAmount);
    const exchangeRate = Number(quote && quote.exchangeRate);

    return quote &&
        quote.track === 'digital_forensics' &&
        quote.registrationId === registrationId &&
        ['GHS', 'USD_REFERENCE'].includes(quote.pricingOption) &&
        quote.currency === 'GHS' &&
        Number.isFinite(referenceAmount) &&
        referenceAmount > 0 &&
        Number.isFinite(chargeAmountGhs) &&
        chargeAmountGhs > 0 &&
        Number.isSafeInteger(paystackAmount) &&
        paystackAmount === Math.round(chargeAmountGhs * 100) &&
        (quote.pricingOption === 'GHS'
            ? quote.referenceCurrency === 'GHS' &&
                referenceAmount === chargeAmountGhs &&
                quote.exchangeRate === null
            : quote.referenceCurrency === 'USD' &&
                Number.isFinite(exchangeRate) &&
                exchangeRate > 0 &&
                Math.round(referenceAmount * exchangeRate * 100) === paystackAmount);
}

function renderQuote(quote) {
    if (!validQuote(quote)) {
        throw new Error('The assigned registration price could not be confirmed.');
    }

    registrationPriceQuote = quote;
    selectedCurrency = quote.pricingOption === 'GHS' ? 'GHS' : 'USD';
    sessionStorage.setItem(
        'selectedPricingOption',
        quote.pricingOption
    );

    const isGhs = quote.pricingOption === 'GHS';
    const displayedProgramPrice = isGhs
        ? formatGhs(quote.referenceAmount)
        : formatUsd(quote.referenceAmount);

    ghsBtn.classList.toggle('active', isGhs);
    usdBtn.classList.toggle('active', !isGhs);
    ghsBtn.disabled = Boolean(quote.pricingLocked && !isGhs);
    usdBtn.disabled = Boolean(quote.pricingLocked && isGhs);
    programPriceLabel.textContent = isGhs
        ? 'Program Price (GHS)'
        : 'USD Reference Price';
    totalAmountLabel.textContent = isGhs
        ? 'Total Payable (GHS)'
        : 'GHS Charged by Paystack';
    programPrice.textContent = displayedProgramPrice;
    totalAmount.textContent = formatGhs(
        quote.chargeAmountGhs,
        !isGhs
    );
    paymentMethods.textContent = 'Mobile Money (MTN, Telecel, AT) & Cards';
    payNowBtn.innerHTML =
        `Pay ${displayedProgramPrice} with Paystack <i class="ti ti-arrow-right"></i>`;
    payNowBtn.disabled = quote.canPay === false;

    const notes = [];
    if (quote.existingRegistrationPrice) {
        notes.push(
            'This registration was assigned an earlier price; its original price is being retained.'
        );
    }
    if (!isGhs) {
        notes.push(
            `${formatUsd(quote.referenceAmount)} is the reference price. ` +
            `At 1 USD = ${formatGhs(quote.exchangeRate, true)}, ` +
            `Paystack will charge ${formatGhs(quote.chargeAmountGhs, true)}.`
        );
    }

    if (notes.length) {
        conversionNote.textContent = notes.join(' ');
        conversionNote.hidden = false;
        conversionNote.style.display = 'block';
    } else {
        conversionNote.textContent = '';
        conversionNote.hidden = true;
        conversionNote.style.display = '';
    }

    if (quote.canPay === false) {
        showPaymentMessage(
            quote.transactionStatus === 'success'
                ? 'A previous payment succeeded and is awaiting server verification. Do not make another payment.'
                : 'A previous payment is still processing. Please wait for verification before trying again.',
            'info'
        );
    } else if (quote.transactionStatus === 'failed' ||
        quote.transactionStatus === 'abandoned') {
        showPaymentMessage(
            'The previous payment attempt did not complete. You can try again.',
            'info'
        );
    } else {
        paymentMessage.textContent = '';
        paymentMessage.style.display = 'none';
    }
}

async function loadRegistrationPrice() {
    const requestId = ++quoteRequestId;
    const requestedPricingOption =
        selectedCurrency === 'GHS' ? 'GHS' : 'USD_REFERENCE';

    registrationPriceQuote = null;
    ghsBtn.disabled = true;
    usdBtn.disabled = true;
    payNowBtn.disabled = true;
    programPrice.textContent = 'Confirming assigned price...';
    totalAmount.textContent = 'Confirming...';
    conversionNote.hidden = true;
    conversionNote.style.display = '';

    try {
        const response = await fetch('/api/initialize-digital-forensics-payment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                operation: 'quote',
                email: applicantEmail,
                registrationId,
                pricingOption: requestedPricingOption
            })
        });
        const result = await response.json();

        if (!response.ok) {
            throw new Error(
                result.error || 'The assigned registration price could not be loaded.'
            );
        }
        if (requestId !== quoteRequestId) return;

        renderQuote(result);
        if (!result.pricingLocked) {
            ghsBtn.disabled = false;
            usdBtn.disabled = false;
        }
    } catch (error) {
        if (requestId !== quoteRequestId) return;
        console.error('Could not load the assigned Digital Forensics price:', error);
        showPaymentMessage(
            error.message || 'The assigned registration price could not be loaded.',
            'error'
        );
    }
}

async function initializePayment() {
    if (!registrationId || !applicantEmail || !registrationPriceQuote) {
        throw new Error(
            'Your assigned registration price could not be confirmed. Please refresh and try again.'
        );
    }

    const quote = registrationPriceQuote;
    const expectedQuote = {
        pricingOption: quote.pricingOption,
        referenceAmount: quote.referenceAmount,
        referenceCurrency: quote.referenceCurrency,
        chargeAmountGhs: quote.chargeAmountGhs,
        paystackAmount: quote.paystackAmount,
        exchangeRate: quote.exchangeRate
    };
    const response = await fetch('/api/initialize-digital-forensics-payment', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            email: applicantEmail,
            registrationId,
            pricingOption: quote.pricingOption,
            expectedQuote
        })
    });

    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error('The payment server returned an unexpected response.');
    }

    if (!response.ok) {
        if (result.quote) {
            renderQuote(result.quote);
            return {
                priceChanged: result.quote.canPay !== false,
                blocked: result.quote.canPay === false
            };
        }
        throw new Error(
            result.error || 'We could not initialize your payment. Please try again.'
        );
    }

    if (!result.authorizationUrl) {
        throw new Error(
            result.error || 'We could not initialize your payment. Please try again.'
        );
    }

    if (
        result.track !== 'digital_forensics' ||
        result.registrationId !== registrationId ||
        result.currency !== 'GHS' ||
        result.pricingOption !== quote.pricingOption ||
        result.referenceCurrency !== quote.referenceCurrency ||
        Number(result.referenceAmount) !== quote.referenceAmount ||
        Number(result.chargeAmountGhs) !== quote.chargeAmountGhs ||
        Number(result.paystackAmount) !== quote.paystackAmount ||
        (result.exchangeRate || null) !== quote.exchangeRate
    ) {
        throw new Error(
            'The selected payment amount could not be confirmed. Please try again.'
        );
    }

    return result;
}

async function startPaystackPayment() {
    if (!registrationId || !applicantEmail || !registrationPriceQuote) {
        showPaymentMessage(
            'Your registration or assigned price could not be confirmed. Please refresh and try again.',
            'error'
        );
        return;
    }

    payNowBtn.disabled = true;
    payNowBtn.innerHTML = '<i class="ti ti-loader-2 dfir-spin"></i> Opening Paystack...';
    showPaymentMessage('Preparing your payment...', 'info');

    try {
        const payment = await initializePayment();
        if (payment.blocked) {
            return;
        }
        if (payment.priceChanged) {
            showPaymentMessage(
                'The assigned price changed. Review the updated amount before continuing.',
                'info'
            );
            return;
        }
        showPaymentMessage(
            'Redirecting you to secure Paystack checkout...',
            'success'
        );
        window.location.href = payment.authorizationUrl;
    } catch (error) {
        console.error('Digital Forensics payment initialization error:', error);
        payNowBtn.disabled = !registrationPriceQuote ||
            registrationPriceQuote.canPay === false;
        showPaymentMessage(
            error.message || 'We could not prepare your payment. Please try again.',
            'error'
        );
    }
}

ghsBtn.addEventListener('click', () => {
    if (selectedCurrency === 'GHS' || registrationPriceQuote?.pricingLocked) return;

    selectedCurrency = 'GHS';
    sessionStorage.setItem('selectedPricingOption', 'GHS');
    loadRegistrationPrice();
});

usdBtn.addEventListener('click', () => {
    if (selectedCurrency === 'USD' || registrationPriceQuote?.pricingLocked) return;

    selectedCurrency = 'USD';
    sessionStorage.setItem('selectedPricingOption', 'USD_REFERENCE');
    loadRegistrationPrice();
});

payNowBtn.addEventListener('click', startPaystackPayment);
loadRegistrationPrice();
