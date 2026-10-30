(function () {
  const form = document.getElementById('applicantLoginForm');
  const emailInput = document.getElementById('email');
  const button = document.getElementById('sendLinkButton');
  const message = document.getElementById('authMessage');
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get('token');

  function showMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle('auth-error', isError);
  }

  async function verifyMagicLink() {
    window.history.replaceState(null, '', window.location.pathname);
    form.hidden = true;
    showMessage('Checking your secure sign-in link…');

    try {
      const response = await fetch('/api/verify-applicant-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const result = await response.json();

      if (!response.ok || result.authenticated !== true) {
        form.hidden = false;
        showMessage(
          result.error || 'That sign-in link has expired or was already used. Request a new link.',
          true
        );
        return;
      }

      window.location.assign('/applicant-dashboard.html');
    } catch {
      form.hidden = false;
      showMessage('We could not verify that link. Please try again.', true);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    showMessage('');

    try {
      const response = await fetch('/api/request-applicant-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.value })
      });
      const result = await response.json();

      if (!response.ok) {
        showMessage(
          result.error || 'We could not process your request. Please try again.',
          true
        );
        return;
      }

      showMessage("If that email has an account, we've sent a login link");
      form.reset();
    } catch {
      showMessage('We could not reach the sign-in service. Please try again.', true);
    } finally {
      button.disabled = false;
    }
  });

  if (token) {
    verifyMagicLink();
  } else if (new URLSearchParams(window.location.search).get('status') === 'expired') {
    showMessage(
      'That sign-in link has expired or was already used. Request a new link.',
      true
    );
  }
})();
