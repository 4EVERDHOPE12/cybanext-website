/* =========================================================
   MOBILE NAVIGATION
========================================================= */
const hamburgerBtn = document.getElementById('hamburgerBtn');
const mainNav = document.getElementById('mainNav');

function toggleDrawer() {
  const isOpen = mainNav.classList.toggle('open');
  hamburgerBtn.classList.toggle('open');
  hamburgerBtn.setAttribute('aria-expanded', isOpen);
}

function closeDrawer() {
  mainNav.classList.remove('open');
  hamburgerBtn.classList.remove('open');
  hamburgerBtn.setAttribute('aria-expanded', 'false');
}

hamburgerBtn.addEventListener('click', toggleDrawer);

document.addEventListener('click', (event) => {
  const tappedOutsideMenu = !mainNav.contains(event.target);
  const tappedOutsideButton = !hamburgerBtn.contains(event.target);
  if (
    mainNav.classList.contains('open') &&
    tappedOutsideMenu &&
    tappedOutsideButton
  ) {
    closeDrawer();
  }
});

/* Close mobile menu after selecting a link */
const navLinks = mainNav.querySelectorAll('a');
navLinks.forEach((link) => {
  link.addEventListener('click', () => {
    if (mainNav.classList.contains('open')) {
      closeDrawer();
    }
  });
});

/* =========================================================
   CV UPLOAD HELPERS — shared by the change listener below
   and the form submit handler
========================================================= */
const cvInput = document.getElementById('cv');
const cvDropzone = document.getElementById('cvDropzone');
const cvUploadTitle = document.getElementById('cvUploadTitle');
const cvUploadStatus = document.getElementById('cvUploadStatus');
const cvDefaultTitle = 'Drop your Resume / CV here';
const maxCvSize = 10 * 1024 * 1024;

function resetCvUploadUi() {
  if (cvDropzone) cvDropzone.classList.remove('is-dragging', 'is-accepted', 'is-invalid');
  if (cvUploadTitle) cvUploadTitle.textContent = cvDefaultTitle;
  if (cvUploadStatus) cvUploadStatus.textContent = '';
}

function triggerCvRipple() {
  if (!cvDropzone) return;
  cvDropzone.classList.remove('is-rippling');
  void cvDropzone.offsetWidth;
  cvDropzone.classList.add('is-rippling');
  window.setTimeout(() => cvDropzone.classList.remove('is-rippling'), 380);
}

function validateCvFile(file) {
  resetCvUploadUi();
  if (!file) return false;
  const extension = file.name.split('.').pop().toLowerCase();
  let message = '';
  if (!['pdf', 'docx'].includes(extension)) {
    message = 'File type not accepted. Please choose a PDF or DOCX file.';
  } else if (file.size > maxCvSize) {
    message = 'File size exceeds 10MB. Please choose a smaller file.';
  }
  if (message) {
    if (cvInput) cvInput.setCustomValidity(message);
    if (cvDropzone) cvDropzone.classList.add('is-invalid');
    if (cvUploadStatus) cvUploadStatus.textContent = message;
    return false;
  }
  if (cvInput) cvInput.setCustomValidity('');
  if (cvDropzone) cvDropzone.classList.add('is-accepted');
  if (cvUploadTitle) cvUploadTitle.textContent = file.name;
  if (cvUploadStatus) cvUploadStatus.textContent = '✓ File uploaded successfully';
  triggerCvRipple();
  return true;
}

/* =========================================================
   FORM MESSAGE HELPER
========================================================= */
function showFormMessage(statusMsg, message, type) {
  if (!statusMsg) return;
  statusMsg.textContent = message;
  statusMsg.className = `form-status-message ${type}`;
  statusMsg.style.display = 'block';
  statusMsg.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest'
  });
}

/* =========================================================
   APPLICATION FORM
========================================================= */
const applicationForm = document.getElementById('applicationForm');

/* ================= CV SCANNER ================= */
async function scanCvOnServer(file, track) {
  const formData = new FormData();
  formData.append('cv', file);
  formData.append('track', track);

  const response = await fetch('/api/scan-cv', {
    method: 'POST',
    body: formData
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      result.error || 'We could not screen your CV. Please try again.'
    );
  }
  return result;
}

/* ================= APPLICATION FORM SUBMIT ================= */
if (applicationForm) {
  applicationForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    /* ================= ELEMENTS ================= */
    const statusMsg = document.getElementById('applicationStatus');
    const submitBtn = document.getElementById('submitBtn');
    const fullName = document.getElementById('fullName');
    const email = document.getElementById('email');
    const track = document.getElementById('track');
    const reason = document.getElementById('reason');

    /* ================= VALIDATION ================= */
    if (!fullName.value.trim()) {
      showFormMessage(statusMsg, 'Please enter your full name.', 'error');
      fullName.focus();
      return;
    }
    if (!email.value.trim()) {
      showFormMessage(statusMsg, 'Please enter your email address.', 'error');
      email.focus();
      return;
    }
    if (!email.validity.valid) {
      showFormMessage(statusMsg, 'Please enter a valid email address.', 'error');
      email.focus();
      return;
    }
    if (!track.value) {
      showFormMessage(statusMsg, 'Please select an internship track.', 'error');
      track.focus();
      return;
    }
    if (!reason.value.trim()) {
      showFormMessage(statusMsg, 'Please tell us why you want to join this track.', 'error');
      reason.focus();
      return;
    }

    /* ================= CV VALIDATION ================= */
    const selectedCv = cvInput?.files?.[0];
    if (!selectedCv) {
      showFormMessage(statusMsg, 'Please upload your CV before continuing.', 'error');
      cvInput?.focus();
      return;
    }

    /* Reuse the existing CV validation function */
    if (!validateCvFile(selectedCv)) {
      return;
    }

    /* ================= CV SCREENING ================= */
    submitBtn.disabled = true;
    submitBtn.innerHTML =
      '<i class="ti ti-loader-2" aria-hidden="true"></i> Scanning CV...';
    cvDropzone?.classList.add('is-scanning');

    if (cvUploadStatus) {
      cvUploadStatus.textContent = 'Scanning your CV securely...';
    }

    showFormMessage(
      statusMsg,
      'We are reviewing your CV. Please wait...',
      'info'
    );

    try {
      const scanResult = await scanCvOnServer(selectedCv, track.value);

      /* ================= DISQUALIFIED ================= */
      if (!scanResult.qualified) {
        cvDropzone?.classList.remove('is-scanning');
        cvDropzone?.classList.add('is-screening-failed');

        if (cvUploadStatus) {
          cvUploadStatus.textContent = 'Screening complete';
        }

        showFormMessage(
          statusMsg,
          'Thank you for your interest. Based on the information in your CV, your application cannot continue to the next stage at this time.',
          'error'
        );

        submitBtn.disabled = false;
        submitBtn.innerHTML =
          'Submit Application <i class="ti ti-arrow-right" aria-hidden="true"></i>';
        return;
      }

      /* ================= QUALIFIED ================= */
      cvDropzone?.classList.remove('is-scanning', 'is-screening-failed');
      cvDropzone?.classList.add('is-screening-passed');

      if (cvUploadStatus) {
        cvUploadStatus.textContent = '✓ CV screening complete';
      }

      showFormMessage(
        statusMsg,
        'Your CV has passed the initial screening. Your application can continue to the next stage.',
        'success'
      );

      submitBtn.disabled = false;
      submitBtn.innerHTML =
        'Continue <i class="ti ti-arrow-right" aria-hidden="true"></i>';
    } catch (error) {
      /* ================= SCREENING ERROR ================= */
      console.error('CV screening error:', error);
      cvDropzone?.classList.remove('is-scanning');

      if (cvUploadStatus) {
        cvUploadStatus.textContent = 'Screening failed';
      }

      showFormMessage(
        statusMsg,
        error.message || 'We could not screen your CV right now. Please try again.',
        'error'
      );

      submitBtn.disabled = false;
      submitBtn.innerHTML =
        'Submit Application <i class="ti ti-arrow-right" aria-hidden="true"></i>';
    }
  });
}

/* =========================================================
   CONTACT FORM
========================================================= */
const contactForm = document.getElementById('contactForm');
if (contactForm) {
  contactForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const statusMsg = document.getElementById('contactStatus');
    const submitBtn = document.getElementById('contactSubmitBtn');
    const contactName = document.getElementById('contactName');
    const contactEmail = document.getElementById('contactEmail');
    const contactReason = document.getElementById('contactReason');
    const contactMessage = document.getElementById('contactMessage');

    /* ================= VALIDATION ================= */
    if (!contactName.value.trim()) {
      showFormMessage(statusMsg, 'Please enter your name.', 'error');
      contactName.focus();
      return;
    }
    if (!contactEmail.value.trim()) {
      showFormMessage(statusMsg, 'Please enter your email address.', 'error');
      contactEmail.focus();
      return;
    }
    if (!contactEmail.validity.valid) {
      showFormMessage(statusMsg, 'Please enter a valid email address.', 'error');
      contactEmail.focus();
      return;
    }
    if (!contactReason.value) {
      showFormMessage(statusMsg, 'Please select a reason for contacting us.', 'error');
      contactReason.focus();
      return;
    }
    if (!contactMessage.value.trim()) {
      showFormMessage(statusMsg, 'Please enter your message.', 'error');
      contactMessage.focus();
      return;
    }

    /* ================= SUBMITTING ================= */
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Sending...';

    try {
      const response = await fetch(contactForm.action, {
        method: 'POST',
        body: new FormData(contactForm),
        headers: {
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        showFormMessage(
          statusMsg,
          "Thank you! Your message has been sent. We'll be in touch soon.",
          'success'
        );
        contactForm.reset();
      } else {
        throw new Error('Contact submission failed');
      }
    } catch (error) {
      showFormMessage(
        statusMsg,
        'Something went wrong while sending your message. Please try again.',
        'error'
      );
    }

    /* Restore button */
    submitBtn.disabled = false;
    submitBtn.innerHTML =
      'Send Message <i class="ti ti-arrow-right" aria-hidden="true"></i>';
  });
}

/* =========================================================
   CV DROPZONE & DRAG EVENTS
========================================================= */
if (cvInput && cvDropzone) {
  cvDropzone.addEventListener('click', () => cvInput.click());

  cvDropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      cvInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    cvDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      cvDropzone.classList.add('is-dragging');
      triggerCvRipple();
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    cvDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (eventName === 'drop' || !cvDropzone.contains(event.relatedTarget)) {
        cvDropzone.classList.remove('is-dragging');
      }
    });
  });

  cvDropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    cvInput.files = transfer.files;
    cvInput.dispatchEvent(new Event('change', { bubbles: true }));
  });

  cvInput.addEventListener('change', () => {
    const selectedFile = cvInput.files[0];
    if (!selectedFile) {
      resetCvUploadUi();
      return;
    }
    validateCvFile(selectedFile);
  });

  applicationForm?.addEventListener('reset', () => {
    window.setTimeout(resetCvUploadUi, 0);
  });
}