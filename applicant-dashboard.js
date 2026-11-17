(async function () {
  const menuToggle = document.getElementById('menuToggleButton');
  const primaryNav = document.getElementById('primaryNavigation');
  const navigationLinks = primaryNav
    ? Array.from(primaryNav.querySelectorAll('[data-dashboard-link]'))
    : [];
  const logoutButton = document.getElementById('logoutButton');
  const supportLink = document.getElementById('supportLink');
  const payButton = document.getElementById('payNowButton');
  const receiptActions = document.getElementById('receiptActions');
  const downloadReceiptButton = document.getElementById('downloadReceiptButton');
  const resendReceiptButton = document.getElementById('resendReceiptButton');
  const receiptActionMessage = document.getElementById('receiptActionMessage');

  const welcomeName = document.getElementById('welcomeName');
  const userNameLabel = document.getElementById('userNameLabel');
  const applicationReferenceText = document.getElementById('applicationReferenceText');
  const trackValue = document.getElementById('trackValue');
  const applicationStatusValue = document.getElementById('applicationStatusValue');
  const paymentValue = document.getElementById('paymentValue');
  const applicationTrackValue = document.getElementById('applicationTrackValue');
  const applicationReferenceValue = document.getElementById('applicationReferenceValue');
  const submissionDateValue = document.getElementById('submissionDateValue');
  const applicantEmailValue = document.getElementById('applicantEmailValue');
  const applicationStatusDetail = document.getElementById('applicationStatusDetail');
  const paymentAlertText = document.getElementById('paymentAlertText');
  const amountValue = document.getElementById('amountValue');
  const paymentStatusValue = document.getElementById('paymentStatusValue');
  const paymentReferenceItem = document.getElementById('paymentReferenceItem');
  const referenceValue = document.getElementById('referenceValue');
  const verifiedTransactionItem = document.getElementById('verifiedTransactionItem');
  const verifiedTransactionValue = document.getElementById('verifiedTransactionValue');
  const paymentVerifiedDateItem = document.getElementById('paymentVerifiedDateItem');
  const paymentVerifiedDateValue = document.getElementById('paymentVerifiedDateValue');
  const progressList = document.getElementById('progressList');
  const applicationCard = document.getElementById('applicationCard');
  const paymentCard = document.getElementById('paymentCard');

  function formatMoney(value, currency = 'GHS') {
    if (value === null || value === undefined) {
      return '—';
    }
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

  function formatDate(value) {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return date.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
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

  function applicationStatusLabel(status) {
    if (status === 'payment_verified') {
      return 'Confirmed';
    }
    return status === 'unknown' ? 'Status unavailable' : 'Received';
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

  function setMenuOpen(open, returnFocus = false) {
    if (!menuToggle || !primaryNav) {
      return;
    }

    const isOpen = Boolean(open);
    primaryNav.dataset.open = String(isOpen);
    const hideNavigation = window.innerWidth <= 820 && !isOpen;
    primaryNav.inert = hideNavigation;
    primaryNav.setAttribute('aria-hidden', String(hideNavigation));
    menuToggle.setAttribute('aria-expanded', String(isOpen));
    menuToggle.setAttribute(
      'aria-label',
      isOpen ? 'Close navigation menu' : 'Open navigation menu'
    );

    if (isOpen) {
      primaryNav.querySelector('[data-dashboard-link]')?.focus({ preventScroll: true });
    } else if (returnFocus) {
      menuToggle.focus();
    }
  }

  setMenuOpen(false);

  function setCurrentNavigation(link) {
    navigationLinks.forEach((item) => {
      if (item === link) {
        item.setAttribute('aria-current', 'page');
      } else {
        item.removeAttribute('aria-current');
      }
    });
  }

  function synchronizeCurrentNavigation() {
    const currentLink = navigationLinks.find(
      (link) => link.getAttribute('href') === window.location.hash
    ) || navigationLinks.find((link) => link.getAttribute('href') === '#overview');

    if (currentLink) {
      setCurrentNavigation(currentLink);
    }
  }

  function renderProgress(data) {
    const status = normalizeStatus(data.status);
    const submittedDate = formatDate(data.createdAt);
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
        note: submittedDate !== '—' ? `Submitted on ${submittedDate}` : null,
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
    const applicationStatus = applicationStatusLabel(status);
    const paymentReference = data.paymentReference || null;
    const canPay = data.canPay === true &&
      ['pending', 'payment_failed'].includes(status);
    const verified = status === 'payment_verified';
    const canUseReceiptActions = data.track === 'Digital Forensics' &&
      verified &&
      data.canDownloadReceipt === true &&
      data.canResendReceipt === true;

    welcomeName.textContent = fullName;
    userNameLabel.textContent = fullName;
    applicationReferenceText.textContent = `Application reference: ${reference}`;
    trackValue.textContent = track;
    applicationStatusValue.textContent = applicationStatus;
    paymentValue.textContent = paymentStatus;
    applicationTrackValue.textContent = track;
    applicationReferenceValue.textContent = reference;
    submissionDateValue.textContent = formatDate(data.createdAt);
    applicantEmailValue.textContent = data.email || '—';
    applicationStatusDetail.textContent = applicationStatus;
    amountValue.textContent = formatMoney(data.amountDue, data.currency);
    paymentStatusValue.textContent = paymentStatus;
    referenceValue.textContent = paymentReference || '—';
    verifiedTransactionValue.textContent =
      data.verifiedTransactionId === null || data.verifiedTransactionId === undefined
        ? '—'
        : String(data.verifiedTransactionId);
    paymentVerifiedDateValue.textContent =
      formatDate(data.paymentVerificationTimestamp);

    paymentReferenceItem.hidden = !paymentReference;
    verifiedTransactionItem.hidden = !verified ||
      data.verifiedTransactionId === null ||
      data.verifiedTransactionId === undefined;
    paymentVerifiedDateItem.hidden = !verified ||
      !data.paymentVerificationTimestamp ||
      paymentVerifiedDateValue.textContent === '—';

    [applicationCard, paymentCard].forEach((card) => {
      card.classList.remove('status-success', 'status-warning', 'status-danger');
    });
    const tone = statusTone(status);
    if (tone !== 'neutral') {
      paymentCard.classList.add(`status-${tone}`);
      if (status === 'payment_verified') {
        applicationCard.classList.add(`status-${tone}`);
      }
    }

    if (status === 'payment_verified') {
      paymentAlertText.textContent =
        'Paystack has verified your payment. Your registration is confirmed.';
      payButton.hidden = true;
    } else if (status === 'payment_failed') {
      paymentAlertText.textContent = canPay
        ? 'Your last payment attempt failed. You may try again.'
        : 'Your last payment attempt failed. Contact support before trying again.';
      payButton.hidden = !canPay;
    } else if (status === 'payment_initiated') {
      paymentAlertText.textContent =
        'Payment was initiated. Verification is still pending; please refresh this page shortly.';
      payButton.hidden = true;
    } else if (status === 'pending') {
      paymentAlertText.textContent = canPay
        ? 'Your application has been received. Payment has not been started.'
        : 'Your application has been received. Payment is not available right now; contact support for help.';
      payButton.hidden = !canPay;
    } else {
      paymentAlertText.textContent =
        'Your payment status is unavailable. Please contact support before attempting another payment.';
      payButton.hidden = true;
    }
    receiptActions.hidden = !canUseReceiptActions;
    receiptActionMessage.textContent = '';

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

      const result = await response.json();
      if (result.selectionRequired === true) {
        window.location.replace('/applicant-registration-selection.html');
        return null;
      }

      if (!response.ok) {
        paymentAlertText.textContent =
          'Your dashboard could not be refreshed. Please reload the page or contact support.';
        return null;
      }

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
    setMenuOpen(false);
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

  menuToggle?.addEventListener('click', () => {
    setMenuOpen(primaryNav.dataset.open !== 'true');
  });

  document.addEventListener('click', (event) => {
    if (
      primaryNav?.dataset.open === 'true' &&
      !primaryNav.contains(event.target) &&
      !menuToggle?.contains(event.target)
    ) {
      setMenuOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && primaryNav?.dataset.open === 'true') {
      event.preventDefault();
      setMenuOpen(false, true);
    }
  });

  navigationLinks.forEach((link) => {
    link.addEventListener('click', () => {
      setCurrentNavigation(link);
      setMenuOpen(false);
      const href = link.getAttribute('href');
      const destination = href && href.startsWith('#')
        ? document.getElementById(href.slice(1))
        : null;
      destination?.focus({ preventScroll: true });
    });
  });

  synchronizeCurrentNavigation();

  window.addEventListener('hashchange', synchronizeCurrentNavigation);

  window.addEventListener('resize', () => {
    if (window.innerWidth > 820) {
      setMenuOpen(false);
    }
  });

  logoutButton?.addEventListener('click', handleLogout);

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
      payButton.innerHTML = '<span>Continue to payment</span><span class="pay-arrow" aria-hidden="true">→</span>';
      paymentAlertText.textContent = error.message ||
        'We could not open payment checkout right now. Please try again.';
    }
  });

  async function sendReceiptAction(action) {
    const buttons = [downloadReceiptButton, resendReceiptButton];
    buttons.forEach((button) => {
      button.disabled = true;
    });
    receiptActionMessage.textContent = 'Processing your receipt request…';

    try {
      const response = await fetch('/api/applicant-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: action === 'download-receipt'
            ? 'application/pdf, application/json'
            : 'application/json'
        },
        body: JSON.stringify({ action }),
        cache: 'no-store',
        credentials: 'same-origin'
      });

      if (response.status === 401) {
        window.location.replace('/applicant-login.html');
        return;
      }

      if (action === 'download-receipt') {
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || 'Your receipt could not be downloaded.');
        }
        const pdf = await response.blob();
        const url = window.URL.createObjectURL(pdf);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'Cybanext-Payment-Receipt.pdf';
        link.click();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        receiptActionMessage.textContent = 'Your receipt download has started.';
        return;
      }

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || 'Your receipt email request could not be processed.');
      }
      receiptActionMessage.textContent =
        result.message || 'Your receipt email request has been accepted.';
    } catch (error) {
      receiptActionMessage.textContent = error.message ||
        'We could not process your receipt request. Please try again.';
    } finally {
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  }

  downloadReceiptButton?.addEventListener('click', () => {
    return sendReceiptAction('download-receipt');
  });

  resendReceiptButton?.addEventListener('click', () => {
    return sendReceiptAction('resend-receipt');
  });

  const applicant = await ensureAuthenticated();
  if (applicant) {
    renderDashboard(applicant);
  }
})();
