(async function () {
  const message = document.getElementById('dashboardMessage');

  try {
    const response = await fetch('/api/applicant-session', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    if (!response.ok) {
      window.location.replace('/applicant-login.html');
      return;
    }

    const result = await response.json();
    if (result.authenticated !== true) {
      window.location.replace('/applicant-login.html');
      return;
    }

    message.textContent =
      'You are signed in. Applicant dashboard features are not part of this release.';
  } catch {
    message.textContent =
      'We could not validate your session. Please return to sign in.';
    message.classList.add('auth-error');
  }
})();
