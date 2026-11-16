(async function () {
  const logoutButtons = [
    document.getElementById('logoutButton'),
    document.getElementById('sidebarLogoutButton')
  ].filter(Boolean);

  const supportLink = document.getElementById('supportLink');
  const payButton = document.getElementById('payNowButton');

  const welcomeName = document.getElementById('welcomeName');
  const userNameLabel = document.getElementById('userNameLabel');
  const applicationReferenceText = document.getElementById('applicationReferenceText');
  const trackValue = document.getElementById('trackValue');
  const applicationStatusValue = document.getElementById('applicationStatusValue');
  const paymentValue = document.getElementById('paymentValue');
  const paymentAlertText = document.getElementById('paymentAlertText');
  const amountValue = document.getElementById('amountValue');
  const paymentStatusValue = document.getElementById('paymentStatusValue');
  const referenceValue = document.getElementById('referenceValue');
  const progressList = document.getElementById('progressList');

  const paymentCard = document.getElementById('paymentCard');

  function formatMoney(value, currency = 'GHS') {
    const amount = Number(value);
    if (!Number.isFinite(amount) || !currency) {
      return '—';
    }
    if (currency === 'USD') {
      return `US$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    if (currency !== 'GHS') {
      return '—';
    }
    return `GH₵${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function normalizeStatus(status) {
    switch (status) {
      case 'paid':
      case 'payment_verified':
        return 'payment_verified';
      case 'payment_initiated':
      case 'payment_failed':
      case 'pending':
        return status;
      default:
        return 'unknown';
    }
  }

  function paymentStatusLabel(status) {
    switch (status) {
      case 'payment_verified':
        return 'Verified';
      case 'payment_initiated':
        return 'Verification pending';
      case 'payment_failed':
        return 'Payment failed';
      case 'pending':
        return 'Not started';
      default:
        return 'Status unavailable';
    }
  }

  function statusTone(status) {
    switch (status) {
      case 'payment_verified':
        return 'success';
      case 'payment_failed':
        return 'danger';
      case 'pending':
      case 'payment_initiated':
        return 'warning';
      default:
        return 'neutral';
    }
  }

  function buildSupportMailto(applicationReference) {
    const reference = applicationReference || 'Unknown';
    const subject = `Applicant Support – ${reference}`;
    const body = [
      'Hello Cybanext Support,',
      '',
      'I would like help with my application, payment or receipt.',
      '',
      'Application reference: ' + reference,
      '',
      'Please assist me with the issue below:',
      '',
      ''
    ].join('\n');

    return `mailto:support@cybanext.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function renderProgress(data) {
    const status = normalizeStatus(data.status);
    const submittedDate = data.createdAt
      ? new Date(data.createdAt).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      })
      : null;
    const paymentStep = {
      payment_verified: {
        label: 'Payment verified',
        note: 'Your payment has been confirmed.',
        state: 'completed'
      },
      payment_initiated: {
        label: 'Verification pending',
        note: 'Paystack verification has not completed yet.',
        state: 'active'
      },
      payment_failed: {
        label: 'Payment failed',
        note: 'You may retry the payment from this dashboard.',
        state: 'active'
      },
      pending: {
        label: 'Payment not started',
        note: 'Complete payment to confirm your registration.',
        state: 'upcoming'
      },
      unknown: {
        label: 'Payment status unavailable',
        note: 'Contact support to confirm your payment status.',
        state: 'upcoming'
      }
    }[status];
    const steps = [
      {
        label: 'Application received',
        note: submittedDate ? `Submitted on ${submittedDate}` : null,
        state: 'completed'
      },
      paymentStep
    ];

    progressList.textContent = '';
    steps.forEach((step) => {
      const item = document.createElement('li');
      item.className = `progress-step ${step.state}`;

      const dot = document.createElement('span');
      dot.className = 'step-dot';
      dot.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('div');
      const heading = document.createElement('h3');
      heading.textContent = step.label;
      copy.appendChild(heading);

      if (step.note) {
        const note = document.createElement('p');
        note.textContent = step.note;
        copy.appendChild(note);
      }

      item.append(dot, copy);
      progressList.appendChild(item);
    });
  }

  function renderDashboard(data) {
    const fullName = data.fullName || 'Applicant';
    const reference = data.registrationId || data.reference || '—';
    const track = data.track || '—';
    const status = normalizeStatus(data.status);
    const paymentStatus = paymentStatusLabel(status);
    const applicationStatus = status === 'payment_verified'
      ? 'Confirmed'
      : status === 'unknown'
        ? 'Status unavailable'
        : 'Received';
    const paymentReference = data.paymentReference || '—';

    welcomeName.textContent = fullName;
    userNameLabel.textContent = fullName;
    applicationReferenceText.textContent = `Application reference: ${reference}`;
    trackValue.textContent = track;
    applicationStatusValue.textContent = applicationStatus;
    paymentValue.textContent = paymentStatus;
    amountValue.textContent = formatMoney(data.amountDue, data.currency);
    paymentStatusValue.textContent = paymentStatus;
    referenceValue.textContent = paymentReference;

    paymentCard.classList.remove('status-success', 'status-warning', 'status-danger');
    const tone = statusTone(status);
    if (tone !== 'neutral') {
      paymentCard.classList.add(`status-${tone}`);
    }

    if (status === 'payment_verified') {
      paymentAlertText.textContent = 'Paystack has verified your payment. Your registration is confirmed.';
      payButton.hidden = true;
    } else if (status === 'payment_failed') {
      paymentAlertText.textContent = 'Your last payment attempt failed. You may try again.';
      payButton.hidden = !data.canPay;
    } else if (status === 'payment_initiated') {
      paymentAlertText.textContent = 'Payment was initiated. Verification is still pending; please refresh this page shortly.';
      payButton.hidden = true;
    } else if (status === 'pending') {
      paymentAlertText.textContent = 'Your application has been received. Payment has not been started.';
      payButton.hidden = !data.canPay;
    } else {
      paymentAlertText.textContent = 'Your payment status is unavailable. Please contact support before attempting another payment.';
      payButton.hidden = true;
    }

    if (supportLink) {
      supportLink.href = buildSupportMailto(reference);
    }

    renderProgress({
      createdAt: data.createdAt,
      status
    });
  }

  async function ensureAuthenticated() {
    try {
      const response = await fetch('/api/applicant-session?includeDashboard=true', {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });

      if (response.status === 401) {
        window.location.replace('/applicant-login.html');
        return null;
      }

      if (!response.ok) {
        paymentAlertText.textContent =
          'Your dashboard could not be refreshed. Please reload the page or contact support.';
        return null;
      }

      const result = await response.json();
      if (result.authenticated !== true || !result.applicant) {
        window.location.replace('/applicant-login.html');
        return null;
      }

      return result.applicant;
    } catch {
      paymentAlertText.textContent =
        'Your dashboard could not be reached. Please check your connection and reload the page.';
      return null;
    }
  }

  async function handleLogout() {
    try {
      const response = await fetch('/api/logout-applicant', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });

      if (response.ok) {
        window.location.replace('/applicant-login.html');
        return;
      }

      const result = await response.json().catch(() => ({}));
      console.error('Logout failed:', result.error || 'Unknown error');
      window.location.replace('/applicant-login.html');
    } catch {
      window.location.replace('/applicant-login.html');
    }
  }

  logoutButtons.forEach((button) => {
    button.addEventListener('click', handleLogout);
  });

  payButton?.addEventListener('click', async () => {
    const payload = await ensureAuthenticated();
    if (!payload || !payload.registrationId) {
      return;
    }

    payButton.disabled = true;
    payButton.textContent = 'Opening checkout…';

    try {
      const response = await fetch('/api/initialize-digital-forensics-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          registrationId: payload.registrationId,
          email: payload.email,
          pricingOption: payload.pricingOption || 'GHS'
        })
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.authorizationUrl) {
        throw new Error(result.error || 'Unable to open payment checkout.');
      }

      window.location.assign(result.authorizationUrl);
    } catch (error) {
      payButton.disabled = false;
      payButton.innerHTML = '<span>Pay now</span><span class="pay-arrow" aria-hidden="true">→</span>';
      paymentAlertText.textContent = error.message || 'We could not open payment checkout right now. Please try again.';
    }
  });

  const applicant = await ensureAuthenticated();
  if (applicant) {
    renderDashboard(applicant);
  }
})();
