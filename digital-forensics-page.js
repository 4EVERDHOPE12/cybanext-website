(function (root, createRegistrationFormHandler) {
  const attachRegistrationForm =
    createRegistrationFormHandler(root.registerDigitalForensicsApplicant);

  if (typeof module === 'object' && module.exports) {
    module.exports = createRegistrationFormHandler;
    module.exports.createPricingOptionHandler = createPricingOptionHandler;
    return;
  }

  const form = root.document.getElementById('digitalForensicsRegistrationForm');
  if (form) {
    attachRegistrationForm({
      form,
      fullNameInput: root.document.getElementById('dfFullName'),
      emailInput: root.document.getElementById('dfEmail'),
      phoneInput: root.document.getElementById('dfPhone'),
      smsConsentInput: root.document.getElementById('dfSmsConsent'),
      submitButton: root.document.getElementById('dfRegistrationSubmit'),
      statusElement: root.document.getElementById('dfRegistrationStatus'),
      navigate: (path) => {
        root.location.href = path;
      }
    });
  }

  const statusElement = root.document.getElementById('dfRegistrationStatus');
  root.document.querySelectorAll('[data-pricing-option]').forEach((link) => {
    link.addEventListener(
      'click',
      createPricingOptionHandler(() => root.sessionStorage, statusElement)
    );
  });
})(globalThis, function createRegistrationFormHandler(registerApplicant) {
  return function attachRegistrationForm({
    form,
    fullNameInput,
    emailInput,
    phoneInput,
    smsConsentInput,
    submitButton,
    statusElement,
    navigate
  }) {
    if (typeof registerApplicant !== 'function') {
      throw new Error('Digital Forensics registration is unavailable.');
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      if (smsConsentInput?.checked && !phoneInput.value.trim()) {
        statusElement.textContent =
          'Enter a valid Ghanaian phone number to consent to SMS notifications.';
        statusElement.classList.add('is-error');
        phoneInput.focus();
        return;
      }

      submitButton.disabled = true;
      statusElement.textContent = 'Saving your course registration...';
      statusElement.classList.remove('is-error');

      try {
        await registerApplicant({
          fullName: fullNameInput.value.trim(),
          email: emailInput.value.trim(),
          phone: phoneInput.value.trim(),
          smsConsent: Boolean(smsConsentInput && smsConsentInput.checked),
          consentSource: 'digital_forensics_standalone'
        });
        navigate('./payment/digital-forensics.html');
      } catch (error) {
        statusElement.textContent =
          error instanceof Error
            ? error.message
            : 'We could not save your registration. Please try again.';
        statusElement.classList.add('is-error');
        submitButton.disabled = false;
      }
    });
  };
});

function createPricingOptionHandler(getStorage, statusElement) {
  return function selectPricingOption(event) {
    const pricingOption = event.currentTarget.dataset.pricingOption;

    if (pricingOption !== 'GHS' && pricingOption !== 'USD_REFERENCE') {
      event.preventDefault();
      statusElement.textContent = 'Please choose a valid applicant price.';
      statusElement.classList.add('is-error');
      return;
    }

    try {
      getStorage().setItem('selectedPricingOption', pricingOption);
      statusElement.textContent = '';
      statusElement.classList.remove('is-error');
    } catch {
      event.preventDefault();
      statusElement.textContent =
        'We could not save your selected pricing. Please try again.';
      statusElement.classList.add('is-error');
    }
  };
}
