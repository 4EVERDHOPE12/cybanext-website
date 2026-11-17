(function () {
  const form = document.getElementById('receiptResendForm');
  const emailInput = document.getElementById('email');
  const button = document.getElementById('requestReceiptButton');
  const message = document.getElementById('receiptMessage');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = 'Sending request…';
    message.textContent = '';
    message.classList.remove('auth-error');

    try {
      const response = await fetch('/api/applicant-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          action: 'request-receipt-resend',
          email: emailInput.value
        }),
        cache: 'no-store',
        credentials: 'same-origin'
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          result.error || 'We could not process your request. Please try again.'
        );
      }

      message.textContent =
        result.message ||
        'If an eligible paid application is found, the receipt will be sent to the registered email address.';
      form.reset();
    } catch (error) {
      message.textContent = error.message ||
        'We could not reach the receipt service. Please try again.';
      message.classList.add('auth-error');
    } finally {
      button.disabled = false;
      button.textContent = 'Request receipt email';
    }
  });
})();